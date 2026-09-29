import ast
import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.testclient import TestClient

import llm_pipeline
import llm_pipeline.rate_limit as rate_limit_module
import llm_pipeline.routers.runs as runs_module
from llm_pipeline.api_error import STATUS_BY_CODE
from llm_pipeline.api_schemas import ErrorCode
from llm_pipeline.error_handling import register_exception_handlers
from llm_pipeline.main import app
from llm_pipeline.settings import settings

EXPECTED_KEYS = {
    "timestamp",
    "status",
    "error",
    "code",
    "message",
    "request",
    "request_id",
    "details",
    "validations",
}


@pytest.fixture(autouse=True)
def _reset_shared_state(monkeypatch: pytest.MonkeyPatch) -> None:  # pyright: ignore[reportUnusedFunction]
    """Auth and rate-limit state are still process-wide singletons (not yet
    dependency-injected the way the pipeline cache now is — see
    pipeline_loader.PipelineCache) — reset them around every test so one
    test's setup can't leak into another's.

    The pipeline cache itself no longer needs an explicit reset here: each
    test's `client` fixture below uses `with TestClient(app) as client:`,
    which re-runs the app's `lifespan` startup on every test and so
    constructs a brand new PipelineCache (with its own fresh circuit
    breaker) automatically — see main.py's lifespan function. This is a
    direct benefit of moving that state off a bare module-level global.

    (pyright flags this as unused — pytest invokes autouse fixtures via its
    own dependency-injection machinery, invisible to static analysis; a
    known, harmless false positive for this pattern.)"""
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))


@pytest.fixture
def client() -> Iterator[TestClient]:
    # `with` is required (not just `TestClient(app)`), so the app's
    # `lifespan` context manager actually runs — that's what sets
    # app.state.pipeline_cache. Using it this way per-test is also what
    # gives each test a fully isolated PipelineCache for free.
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _assert_matches_error_shape(body: dict[str, object]) -> None:
    assert set(body.keys()) == EXPECTED_KEYS
    assert isinstance(body["timestamp"], str)
    assert isinstance(body["status"], int)
    assert isinstance(body["error"], str)
    assert isinstance(body["code"], str) and body["code"].isupper()
    assert isinstance(body["message"], str)
    assert isinstance(body["request"], str)
    assert isinstance(body["request_id"], str) and body["request_id"] != ""
    assert isinstance(body["details"], dict)
    assert isinstance(body["validations"], list)


def test_pipeline_not_found_matches_error_shape(client: TestClient) -> None:
    response = client.post(
        "/v1/pipelines/does-not-exist/runs", json={"prompt": "hi", "history": []}
    )
    assert response.status_code == 404
    body = response.json()
    _assert_matches_error_shape(body)
    assert body["status"] == 404
    assert body["error"] == "Not Found"
    assert body["code"] == "PIPELINE_NOT_FOUND"
    assert "does-not-exist" in body["message"]
    assert body["request"] == "POST /v1/pipelines/does-not-exist/runs"
    assert body["validations"] == []


def test_empty_prompt_matches_error_shape(client: TestClient) -> None:
    response = client.post("/v1/pipelines/anything/runs", json={"prompt": "   ", "history": []})
    assert response.status_code == 400
    body = response.json()
    _assert_matches_error_shape(body)
    assert body["status"] == 400
    assert body["error"] == "Bad Request"
    assert body["code"] == "INPUT_INVALID"
    assert "empty" in body["message"].lower()


def test_an_oversized_prompt_is_input_too_large(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "max_prompt_length", 10)
    response = client.post(
        "/v1/pipelines/simple-local/runs", json={"prompt": "x" * 11, "history": []}
    )
    assert response.status_code == 400
    assert response.json()["code"] == "INPUT_TOO_LARGE"


def test_malformed_request_body_matches_error_shape_with_validations(
    client: TestClient,
) -> None:
    """Missing required field `prompt` — FastAPI's automatic 422 must
    be mapped into the same ErrorResponse contract, with each individual
    field problem populated as a ValidationIssue in `validations`."""
    response = client.post("/v1/pipelines/simple-local/runs", json={"history": []})
    assert response.status_code == 422
    body = response.json()
    _assert_matches_error_shape(body)
    assert body["status"] == 422
    assert body["error"] == "Unprocessable Entity"
    assert body["code"] == "REQUEST_INVALID"
    assert len(body["validations"]) >= 1
    issue = body["validations"][0]
    assert set(issue.keys()) == {"field", "message", "type"}
    assert any("prompt" in v["field"] for v in body["validations"])


def test_missing_api_key_matches_error_shape(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "api_keys", "secret-key")
    response = client.post("/v1/pipelines/anything/runs", json={"prompt": "hi", "history": []})
    assert response.status_code == 401
    body = response.json()
    _assert_matches_error_shape(body)
    assert body["status"] == 401
    assert body["error"] == "Unauthorized"
    assert body["code"] == "UNAUTHENTICATED"


def test_rate_limit_matches_error_shape_with_retry_after(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Confirms the shared error builder still surfaces Retry-After — both
    as a real response header (forwarded via exc.headers) and mirrored into
    `details`, since that's the one piece of already-structured extra data
    a plain HTTPException carries."""
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1))

    client.get("/v1/pipelines")  # consumes the 1 allowed request in the window
    response = client.get("/v1/pipelines")  # 2nd request within the window — should be limited

    assert response.status_code == 429
    body = response.json()
    _assert_matches_error_shape(body)
    assert body["status"] == 429
    assert body["error"] == "Too Many Requests"
    assert body["code"] == "RATE_LIMITED"
    assert "retry_after_seconds" in body["details"]
    assert "Retry-After" in response.headers


def test_the_error_shape_does_not_depend_on_the_path() -> None:
    """Only the OpenAI-compatible router answers in OpenAI's error shape, and
    it opts in itself. Every other route keeps ErrorResponse — including
    routes under /v1/, which is reserved for this API's own versioning."""
    versioned = APIRouter(prefix="/v1")

    @versioned.get("/things/{thing_id}")
    async def get_thing(thing_id: int) -> None:  # pyright: ignore[reportUnusedFunction]
        raise HTTPException(status_code=404, detail=f"no thing {thing_id}")

    probe = FastAPI()
    register_exception_handlers(probe)
    probe.include_router(versioned)
    with TestClient(probe) as c:
        missing = c.get("/v1/things/1")
        malformed = c.get("/v1/things/not-a-number")

    assert missing.status_code == 404
    _assert_matches_error_shape(missing.json())
    assert malformed.status_code == 422
    _assert_matches_error_shape(malformed.json())


def test_the_api_raises_coded_errors_not_bare_http_exceptions() -> None:
    """A bare HTTPException reaches clients with only a generic fallback
    code, so errors that share a status can't be told apart again. Raise
    ApiError with the ErrorCode that names the failure instead."""
    package = Path(llm_pipeline.__file__).parent
    bare: list[str] = []
    for path in sorted(package.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            name = func.id if isinstance(func, ast.Name) else getattr(func, "attr", None)
            if name == "HTTPException":
                bare.append(f"{path.relative_to(package)}:{node.lineno}")
    assert bare == []


def test_every_code_always_comes_with_the_same_status() -> None:
    """A client that knows the code knows the status: ApiError takes its
    status from this table, so the two can't disagree at a raise site."""
    assert set(STATUS_BY_CODE) == set(ErrorCode)
    assert all(400 <= status <= 599 for status in STATUS_BY_CODE.values())


def test_an_unexpected_failure_during_a_run_is_a_500_that_keeps_its_details_private(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def broken(definition: object) -> None:
        raise RuntimeError("secret internals")

    monkeypatch.setattr(runs_module, "_run_config", broken)
    run = {"prompt": "hi", "history": []}

    answered = client.post("/v1/pipelines/simple-local/runs", json=run)
    assert answered.status_code == 500
    _assert_matches_error_shape(answered.json())
    assert answered.json()["code"] == "INTERNAL_ERROR"
    assert "secret internals" not in answered.text

    streamed = client.post(
        "/v1/pipelines/simple-local/runs", json=run, headers={"Accept": "text/event-stream"}
    )
    error_block = next(b for b in streamed.text.split("\n\n") if b.startswith("event: error"))
    event = json.loads(error_block.split("data: ", 1)[1])
    assert event["status"] == 500 and event["code"] == "INTERNAL_ERROR"
    assert "secret internals" not in streamed.text


def test_request_id_is_consistent_within_one_request(client: TestClient) -> None:
    """request_id should match X-Request-ID for the same request, so ops
    can correlate an error body directly with server log lines."""
    response = client.post(
        "/v1/pipelines/does-not-exist/runs", json={"prompt": "hi", "history": []}
    )
    body = response.json()
    assert response.headers.get("X-Request-ID") == body["request_id"]
