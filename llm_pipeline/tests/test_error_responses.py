from collections.abc import Iterator
import pytest
from fastapi.testclient import TestClient

from llm_pipeline.main import app
import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.settings import settings

EXPECTED_KEYS = {
    "timestamp",
    "status",
    "error",
    "message",
    "request",
    "exceptionUID",
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
    assert isinstance(body["message"], str)
    assert isinstance(body["request"], str)
    assert isinstance(body["exceptionUID"], str) and body["exceptionUID"] != ""
    assert isinstance(body["details"], dict)
    assert isinstance(body["validations"], list)


def test_pipeline_not_found_matches_error_shape(client: TestClient) -> None:
    response = client.post(
        "/ask", json={"prompt": "hi", "pipeline_name": "does-not-exist", "history": []}
    )
    assert response.status_code == 404
    body = response.json()
    _assert_matches_error_shape(body)
    assert body["status"] == 404
    assert body["error"] == "Not Found"
    assert "does-not-exist" in body["message"]
    assert body["request"] == "POST /ask"
    assert body["validations"] == []


def test_empty_prompt_matches_error_shape(client: TestClient) -> None:
    response = client.post(
        "/ask", json={"prompt": "   ", "pipeline_name": "anything", "history": []}
    )
    assert response.status_code == 400
    body = response.json()
    _assert_matches_error_shape(body)
    assert body["status"] == 400
    assert body["error"] == "Bad Request"
    assert "empty" in body["message"].lower()


def test_malformed_request_body_matches_error_shape_with_validations(
    client: TestClient,
) -> None:
    """Missing required field `pipeline_name` — FastAPI's automatic 422 must
    be mapped into the same ErrorResponse contract, with each individual
    field problem populated as a ValidationIssue in `validations`."""
    response = client.post("/ask", json={"prompt": "hi"})
    assert response.status_code == 422
    body = response.json()
    _assert_matches_error_shape(body)
    assert body["status"] == 422
    assert body["error"] == "Unprocessable Entity"
    assert len(body["validations"]) >= 1
    issue = body["validations"][0]
    assert set(issue.keys()) == {"field", "message", "type"}
    assert any("pipeline_name" in v["field"] for v in body["validations"])


def test_missing_api_key_matches_error_shape(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "api_keys", "secret-key")
    response = client.post(
        "/ask", json={"prompt": "hi", "pipeline_name": "anything", "history": []}
    )
    assert response.status_code == 401
    body = response.json()
    _assert_matches_error_shape(body)
    assert body["status"] == 401
    assert body["error"] == "Unauthorized"


def test_rate_limit_matches_error_shape_with_retry_after(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Confirms the shared error builder still surfaces Retry-After — both
    as a real response header (forwarded via exc.headers) and mirrored into
    `details`, since that's the one piece of already-structured extra data
    a plain HTTPException carries."""
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1))

    client.get("/pipelines")  # consumes the 1 allowed request in the window
    response = client.get("/pipelines")  # 2nd request within the window — should be limited

    assert response.status_code == 429
    body = response.json()
    _assert_matches_error_shape(body)
    assert body["status"] == 429
    assert body["error"] == "Too Many Requests"
    assert "retry_after_seconds" in body["details"]
    assert "Retry-After" in response.headers


def test_exception_uid_is_consistent_within_one_request(client: TestClient) -> None:
    """exceptionUID should match X-Request-ID for the same request, so ops
    can correlate an error body directly with server log lines."""
    response = client.post(
        "/ask", json={"prompt": "hi", "pipeline_name": "does-not-exist", "history": []}
    )
    body = response.json()
    assert response.headers.get("X-Request-ID") == body["exceptionUID"]
