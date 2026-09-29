import asyncio
import json
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, AIMessageChunk

import llm_pipeline.dag_builder.node_types as node_types_module
import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.dag_builder.loops import make_loop_failed_node
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.main import app
from llm_pipeline.providers import Generation, LLMProvider, ModelSpec
from llm_pipeline.routers.runs import extract_stream_part, message_text
from llm_pipeline.settings import settings
from llm_pipeline.state import PipelineState

# Asks a run to stream its progress as Server-Sent Events.
STREAM = {"Accept": "text/event-stream"}


def test_extract_stream_part_treats_plain_dict_as_updates() -> None:
    """The documented single-mode astream() shape: the chunk dict directly,
    {node_name: update}."""
    step = {"answer": {"node_outputs": {"answer": {"output": "hi"}}}}
    assert extract_stream_part(step) == ("updates", step)


def test_extract_stream_part_handles_mode_tuple_shape() -> None:
    """With several stream modes requested, LangGraph yields
    (mode_name, payload) tuples — for both "updates" and "custom"."""
    inner = {"answer": {"node_outputs": {"answer": {"output": "hi"}}}}
    assert extract_stream_part(("updates", inner)) == ("updates", inner)
    custom = {"event": "node_start", "node_id": "answer", "model_name": "ollama:x"}
    assert extract_stream_part(("custom", custom)) == ("custom", custom)


def test_extract_stream_part_unpacks_messages_mode() -> None:
    """ "messages" mode yields (message_chunk, metadata) tuples."""
    chunk = AIMessageChunk(content="hel")
    meta = {"langgraph_node": "answer"}
    assert extract_stream_part(("messages", (chunk, meta))) == (
        "messages",
        {"message": chunk, "metadata": meta},
    )
    assert extract_stream_part(("messages", (chunk, "not a dict"))) is None


def test_message_text_handles_strings_and_content_blocks() -> None:
    assert message_text(AIMessageChunk(content="plain")) == "plain"
    blocks = [{"type": "text", "text": "a"}, {"type": "tool_use", "id": "x"}, "b"]
    assert message_text(AIMessageChunk(content=blocks)) == "ab"
    assert message_text(object()) == ""


def test_extract_stream_part_rejects_unrecognized_shapes() -> None:
    assert extract_stream_part("not a chunk") is None
    assert extract_stream_part(("updates", "not a dict")) is None
    assert extract_stream_part(("too", "many", "items")) is None
    assert extract_stream_part((1, {})) is None
    assert extract_stream_part(None) is None


class _EchoProvider:
    def __init__(self, tag: str) -> None:
        self.tag = tag

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        return Generation(f"[{self.tag}]:{prompt}")


class _FailingProvider:
    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        raise RuntimeError("simulated failure")


@pytest.fixture(autouse=True)
def _reset_shared_state(monkeypatch: pytest.MonkeyPatch) -> None:  # pyright: ignore[reportUnusedFunction]
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


def test_a_run_streams_only_when_the_client_accepts_an_event_stream(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One endpoint, two representations: the finished RunResponse, or the
    run's progress as Server-Sent Events — chosen by Accept."""
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _EchoProvider(spec.model))
    run = {"prompt": "hello", "history": []}

    def content_type(accept: str | None) -> str:
        headers = {"Accept": accept} if accept is not None else {}
        response = client.post("/v1/pipelines/simple-local/runs", json=run, headers=headers)
        assert response.status_code == 200
        return response.headers["content-type"].split(";")[0]

    assert content_type(None) == "application/json"
    assert content_type("application/json") == "application/json"
    assert content_type("*/*") == "application/json"
    assert content_type("text/event-stream") == "text/event-stream"
    # The client's preference decides: JSON wins a tie, and */* is no request
    # for a stream.
    assert content_type("application/json, text/event-stream;q=0.5") == "application/json"
    assert content_type("text/event-stream, application/json;q=0.5") == "text/event-stream"
    assert content_type("text/event-stream;q=0, application/json") == "application/json"


def test_the_rpc_style_run_paths_are_gone(client: TestClient) -> None:
    run = {"prompt": "hello", "pipeline_name": "simple-local", "history": []}
    assert client.post("/ask", json=run).status_code == 404
    assert client.post("/ask/stream", json=run).status_code == 404


def test_stream_single_node_pipeline_emits_node_complete_then_done(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        return _EchoProvider(spec.model)

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    response = client.post(
        "/v1/pipelines/simple-local/runs",
        json={"prompt": "hello", "history": []},
        headers=STREAM,
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
        "/v1/pipelines/consensus-qa/runs",
        json={"prompt": "what year is it", "history": []},
        headers=STREAM,
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
        "/v1/pipelines/simple-local/runs",
        json={"prompt": "hello", "history": []},
        headers=STREAM,
    )

    assert response.status_code == 200  # NOT 502, even though the pipeline failed
    events = _parse_sse_events(response.text)

    # The node genuinely started, retried once (simple-local keeps the
    # default max_retries=1), then failed.
    assert [e[0] for e in events] == ["node_start", "node_start", "error"]
    assert [e[1]["attempt"] for e in events[:2]] == [1, 2]
    assert events[0][1]["node_id"] == "answer"
    event_type, data = events[2]
    assert event_type == "error"
    # Same ErrorResponse shape every other error in this API uses.
    assert set(data.keys()) == {
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
    assert data["status"] == 502
    assert data["code"] == "PIPELINE_RUN_FAILED"
    # FR-012 (visual DAG graph): a live-status client needs to know WHICH
    # node failed, not just that the run as a whole did — simple-local has
    # exactly one node, "answer".
    assert data["details"] == {"node_id": "answer"}


def test_loop_exhaustion_failure_carries_loop_id() -> None:
    """PipelineExecutionError raised when a loop exceeds max_iterations
    under on_max_iterations=fail must carry loop_id, not just node_id —
    there's no real failing node in that case (it's the loop's own
    synthetic failed-path node), so loop_id is the only way a live-status
    client can attribute the failure to something concrete. Exercised
    directly against the loop-failed node builder rather than through a
    full HTTP run, since none of the shipped/fixture pipelines configure
    on_max_iterations: fail."""
    node_fn = make_loop_failed_node("revise_until_approved")
    # The node fails without reading the state; any valid one will do.
    empty: PipelineState = {
        "input": "",
        "contextual_input": "",
        "history": "",
        "node_outputs": {},
        "loop_counts": {},
    }

    async def run_node() -> None:
        await node_fn(empty)

    with pytest.raises(PipelineExecutionError) as exc_info:
        asyncio.run(run_node())

    assert exc_info.value.loop_id == "revise_until_approved"
    assert exc_info.value.node_id is None


def test_stream_pipeline_not_found_returns_normal_404_before_streaming(
    client: TestClient,
) -> None:
    """A pre-stream validation failure (unknown pipeline) should behave
    exactly like /ask's 404 — a normal HTTP error status, since nothing has
    started streaming yet at that point."""
    response = client.post(
        "/v1/pipelines/does-not-exist/runs",
        json={"prompt": "hello", "history": []},
        headers=STREAM,
    )
    assert response.status_code == 404
    body = response.json()
    assert "does-not-exist" in body["message"]


# ---------------------------------------------------------------------------
# node_start — real "this node is running now" events
# ---------------------------------------------------------------------------


def test_stream_every_node_start_precedes_its_node_complete(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        return _EchoProvider(spec.model)

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    response = client.post(
        "/v1/pipelines/consensus-qa/runs",
        json={"prompt": "q", "history": []},
        headers=STREAM,
    )
    events = _parse_sse_events(response.text)

    started_at: dict[str, int] = {}
    completed_at: dict[str, int] = {}
    for index, (event_type, data) in enumerate(events):
        if event_type == "node_start":
            started_at[str(data["node_id"])] = index
            assert str(data["model_name"]).startswith("ollama:")
        elif event_type == "node_complete":
            completed_at[data["node"]["node_id"]] = index  # type: ignore[index]

    assert set(started_at) == {"answer_local", "answer_b", "answer_c", "reconcile"}
    assert set(started_at) == set(completed_at)
    for node_id, start_index in started_at.items():
        assert start_index < completed_at[node_id], node_id
    # reconcile depends on all three roots, so it can only start after they finish.
    assert started_at["reconcile"] > max(
        completed_at[n] for n in ("answer_local", "answer_b", "answer_c")
    )


class _BarrierProvider:
    """Only returns once `parties` calls are in flight at the same time —
    so the run can only finish if those calls genuinely run concurrently.
    A serial run would block on the first call until the timeout."""

    def __init__(self, parties: int) -> None:
        self.parties = parties
        self.arrived = 0
        self.all_arrived: asyncio.Event | None = None

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        if self.all_arrived is None:
            self.all_arrived = asyncio.Event()
        self.arrived += 1
        if self.arrived >= self.parties:
            self.all_arrived.set()
        await asyncio.wait_for(self.all_arrived.wait(), timeout=5)
        return Generation("ok")


def test_stream_parallel_roots_all_start_before_any_completes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Once the three roots have met at the barrier it stays open, so the
    # later reconcile call passes straight through.
    barrier = _BarrierProvider(parties=3)
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: barrier)

    response = client.post(
        "/v1/pipelines/consensus-qa/runs",
        json={"prompt": "q", "history": []},
        headers=STREAM,
    )
    events = _parse_sse_events(response.text)
    event_types = [e[0] for e in events]

    assert event_types[-1] == "done"
    first_complete = event_types.index("node_complete")
    roots_started_before = {
        str(data["node_id"])
        for event_type, data in events[:first_complete]
        if event_type == "node_start"
    }
    assert roots_started_before == {"answer_local", "answer_b", "answer_c"}


@pytest.mark.asyncio
async def test_loop_node_emits_node_start_on_every_iteration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from pathlib import Path

    from llm_pipeline.dag_builder import build_graph
    from llm_pipeline.pipeline_config import load_pipeline_definition

    definition = load_pipeline_definition(
        Path(__file__).parent / "fixtures" / "valid" / "simple_loop.yaml"
    )
    responses = iter(["REVISE: a", "REVISE: b", "APPROVE"])

    class _Critique:
        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            return Generation(next(responses))

    critique = _Critique()

    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        return critique if spec.model == "critique-model" else _EchoProvider("gen")

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    graph = build_graph(definition)
    starts: list[str] = []
    async for step in graph.astream(
        {"input": "x", "contextual_input": "x", "node_outputs": {}, "loop_counts": {}},
        stream_mode=["updates", "custom"],
    ):
        part = extract_stream_part(step)
        assert part is not None
        mode, chunk = part
        if mode == "custom":
            starts.append(str(chunk["node_id"]))

    # Three critique rounds (REVISE, REVISE, APPROVE) -> generate and
    # critique each start three times, in alternating order.
    assert starts == ["generate", "critique"] * 3


class _SystemRecordingProvider:
    def __init__(self) -> None:
        self.systems: list[str | None] = []

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        self.systems.append(system)
        return Generation("ok")


@pytest.mark.asyncio
async def test_system_prompt_reaches_the_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    from llm_pipeline.dag_builder import build_graph
    from llm_pipeline.pipeline_config import PipelineDefinition

    definition = PipelineDefinition.model_validate(
        {
            "name": "sys",
            "nodes": [
                {
                    "id": "a",
                    "model": {"provider": "ollama", "name": "m"},
                    "system_prompt": "You are terse.",
                    "prompt_template": "{{ input }}",
                },
                {
                    "id": "b",
                    "depends_on": ["a"],
                    "model": {"provider": "ollama", "name": "m"},
                    "prompt_template": "{{ a.output }}",
                },
            ],
            "output_nodes": ["b"],
        }
    )
    recorder = _SystemRecordingProvider()
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: recorder)

    await build_graph(definition).ainvoke(
        {"input": "x", "contextual_input": "x", "node_outputs": {}, "loop_counts": {}}
    )
    assert recorder.systems == ["You are terse.", None]


# ---------------------------------------------------------------------------
# node_token — live text as each node's model generates it
# ---------------------------------------------------------------------------


class _StreamingChatProvider:
    """A provider backed by a real LangChain chat model (a fake one), the way
    the real adapters are — so LangGraph's messages mode sees its tokens."""

    def __init__(self, text: str) -> None:
        self.text = text

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        llm = GenericFakeChatModel(messages=iter([AIMessage(content=self.text)]))
        result = await llm.ainvoke([("human", prompt)])
        return Generation(str(result.content))


def test_stream_emits_tokens_per_node_between_start_and_complete(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        node_types_module,
        "get_provider",
        lambda spec: _StreamingChatProvider(f"answer from {spec.model} here"),
    )
    response = client.post(
        "/v1/pipelines/consensus-qa/runs",
        json={"prompt": "q", "history": []},
        headers=STREAM,
    )
    events = _parse_sse_events(response.text)
    assert events[-1][0] == "done"

    text: dict[str, str] = {}
    phase: dict[str, str] = {}
    for event_type, data in events:
        if event_type == "node_start":
            phase[str(data["node_id"])] = "running"
        elif event_type == "node_token":
            node_id = str(data["node_id"])
            assert phase.get(node_id) == "running", f"token for {node_id} outside its run"
            text[node_id] = text.get(node_id, "") + str(data["text"])
        elif event_type == "node_complete":
            node = data["node"]
            assert isinstance(node, dict)
            node_id = str(node["node_id"])
            phase[node_id] = "complete"
            # The streamed pieces add up to exactly the final output.
            assert text[node_id] == node["output"]

    # Tokens only ever name real pipeline nodes, never internal graph nodes.
    assert set(text) == {"answer_local", "answer_b", "answer_c", "reconcile"}


@pytest.mark.asyncio
async def test_retry_is_announced_as_a_new_start(monkeypatch: pytest.MonkeyPatch) -> None:
    from llm_pipeline.dag_builder import build_graph
    from llm_pipeline.pipeline_config import PipelineDefinition

    class _FailsOnce:
        calls = 0

        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            _FailsOnce.calls += 1
            if _FailsOnce.calls == 1:
                raise RuntimeError("transient")
            return Generation("ok")

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _FailsOnce())
    definition = PipelineDefinition.model_validate(
        {
            "name": "retry",
            "execution": {"max_retries": 1, "retry_backoff_seconds": 0},
            "nodes": [
                {
                    "id": "a",
                    "model": {"provider": "ollama", "name": "m"},
                    "prompt_template": "{{ input }}",
                }
            ],
            "output_nodes": ["a"],
        }
    )
    starts: list[object] = []
    async for step in build_graph(definition).astream(
        {"input": "x", "contextual_input": "x", "node_outputs": {}, "loop_counts": {}},
        stream_mode=["custom"],
    ):
        part = extract_stream_part(step)
        assert part is not None
        starts.append(part[1]["attempt"])
    assert starts == [1, 2]


def test_node_start_carries_the_messages_the_node_received(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The rendered prompt (dependencies' outputs filled in) and the system
    prompt travel with node_start, so clients can show what each node got."""
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _EchoProvider(spec.model))
    response = client.post(
        "/v1/pipelines/consensus-qa/runs",
        json={"prompt": "what year is it", "history": []},
        headers=STREAM,
    )
    starts = {
        str(data["node_id"]): data
        for event_type, data in _parse_sse_events(response.text)
        if event_type == "node_start"
    }
    assert starts["answer_b"]["prompt"] == (
        "Answer this question accurately and concisely: what year is it"
    )
    assert starts["answer_b"]["system"] is None
    # reconcile received the three answers, rendered into its template.
    reconcile_prompt = str(starts["reconcile"]["prompt"])
    assert "Question: what year is it" in reconcile_prompt
    assert "1: [qwen3-coder:30b]:Answer this question" in reconcile_prompt
    assert "{{" not in reconcile_prompt
