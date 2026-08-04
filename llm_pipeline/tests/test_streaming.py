from collections.abc import Iterator
import json

import pytest
from fastapi.testclient import TestClient

from llm_pipeline.main import app
import llm_pipeline.dag_builder.node_types as node_types_module
import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.settings import settings
from llm_pipeline.providers import ModelSpec, LLMProvider
from llm_pipeline.routers.ask import _extract_chunk


def test_extract_chunk_handles_plain_dict_shape() -> None:
    """The documented astream(stream_mode='updates') shape: the chunk dict
    directly, {node_name: update}."""
    step = {"answer": {"node_outputs": {"answer": {"output": "hi"}}}}
    assert _extract_chunk(step) == step


def test_extract_chunk_handles_tuple_shape() -> None:
    """Some LangGraph versions/configurations yield a (mode_name, chunk)
    tuple even for a single string stream_mode — this is the exact case
    that silently broke streaming entirely before _extract_chunk existed,
    since the old code only checked `isinstance(chunk, dict)` directly."""
    inner = {"answer": {"node_outputs": {"answer": {"output": "hi"}}}}
    step = ("updates", inner)
    assert _extract_chunk(step) == inner


def test_extract_chunk_rejects_unrecognized_shapes() -> None:
    assert _extract_chunk("not a chunk") is None
    assert _extract_chunk(("updates", "not a dict")) is None
    assert _extract_chunk(("too", "many", "items")) is None
    assert _extract_chunk(None) is None


class _EchoProvider:
    def __init__(self, tag: str) -> None:
        self.tag = tag

    async def generate(self, prompt: str) -> str:
        return f"[{self.tag}]:{prompt}"


class _FailingProvider:
    async def generate(self, prompt: str) -> str:
        raise RuntimeError("simulated failure")


@pytest.fixture(autouse=True)
def _reset_shared_state(monkeypatch: pytest.MonkeyPatch) -> None:  # pyright: ignore[reportUnusedFunction]  # noqa: E501
    """Same reasoning as test_error_responses.py's fixture of the same name
    — auth/rate-limit are still process-wide singletons needing an explicit
    reset; the pipeline cache resets itself via lifespan re-running for
    every fresh `with TestClient(app) as client:` block below."""
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _parse_sse_events(raw_text: str) -> list[tuple[str, dict[str, object]]]:
    """Splits a raw SSE response body into (event_type, parsed_json_data)
    pairs, in the order they appeared — mirrors the parsing logic in
    packages/client/src/apiClient.ts's parseSseEvent, kept independent
    (not imported) since this is testing the server's actual wire format,
    not trusting the client's own parser to validate it."""
    events: list[tuple[str, dict[str, object]]] = []
    for block in raw_text.strip().split("\n\n"):
        if not block.strip():
            continue
        event_type = "message"
        data_lines: list[str] = []
        for line in block.split("\n"):
            if line.startswith("event:"):
                event_type = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:") :].strip())
        if data_lines:
            events.append((event_type, json.loads("\n".join(data_lines))))
    return events


def test_stream_single_node_pipeline_emits_node_complete_then_done(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        return _EchoProvider(spec.model)

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    response = client.post(
        "/ask/stream",
        json={"prompt": "hello", "pipeline_name": "simple-local", "history": []},
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")

    events = _parse_sse_events(response.text)
    event_types = [e[0] for e in events]

    assert "node_complete" in event_types
    assert event_types[-1] == "done"

    done_data = events[-1][1]
    assert done_data["pipeline_name"] == "simple-local"
    assert "hello" in str(done_data["final_answer"])


def test_stream_multi_root_pipeline_emits_one_node_complete_per_node(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """consensus-qa.yaml has 4 nodes (3 parallel roots + reconcile) — every
    one of them should produce its own node_complete event before the
    final done event, confirming the astream() consumption loop correctly
    handles a superstep with multiple nodes completing at once (the three
    parallel roots) as well as sequential ones (reconcile, after)."""

    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        return _EchoProvider(spec.model)

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    response = client.post(
        "/ask/stream",
        json={"prompt": "what year is it", "pipeline_name": "consensus-qa", "history": []},
    )

    assert response.status_code == 200
    events = _parse_sse_events(response.text)

    node_complete_ids = {
        e[1]["node"]["node_id"]  # type: ignore[index]
        for e in events
        if e[0] == "node_complete"
    }
    assert node_complete_ids == {"answer_local", "answer_b", "answer_c", "reconcile"}
    assert events[-1][0] == "done"


def test_stream_provider_failure_yields_error_event_with_200_status(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The critical streaming-specific behavior: once the stream has
    started, the HTTP status is always 200 regardless of what happens next
    — a failure surfaces as an `error` SSE event within that 200 response,
    NOT as a different HTTP status code the way /ask's HTTPException-based
    error handling works."""

    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        return _FailingProvider()

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    response = client.post(
        "/ask/stream",
        json={"prompt": "hello", "pipeline_name": "simple-local", "history": []},
    )

    assert response.status_code == 200  # NOT 503, even though the pipeline failed
    events = _parse_sse_events(response.text)

    assert len(events) == 1
    event_type, data = events[0]
    assert event_type == "error"
    # Same ErrorResponse shape every other error in this API uses.
    assert set(data.keys()) == {
        "timestamp",
        "status",
        "error",
        "message",
        "request",
        "exceptionUID",
        "details",
        "validations",
    }
    assert data["status"] == 503


def test_stream_pipeline_not_found_returns_normal_404_before_streaming(
    client: TestClient,
) -> None:
    """A pre-stream validation failure (unknown pipeline) should behave
    exactly like /ask's 404 — a normal HTTP error status, since nothing has
    started streaming yet at that point."""
    response = client.post(
        "/ask/stream",
        json={"prompt": "hello", "pipeline_name": "does-not-exist", "history": []},
    )
    assert response.status_code == 404
    body = response.json()
    assert "does-not-exist" in body["message"]
