"""Pipeline-wide settings: node defaults, per-node history, reasoning
stripping, parallelism limit, remembered outputs, history summaries — and
the template sandbox."""

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient
from jinja2.exceptions import SecurityError

import llm_pipeline.dag_builder.node_types as node_types_module
import llm_pipeline.rate_limit as rate_limit_module
import llm_pipeline.routers.runs as runs_module
from llm_pipeline.dag_builder.reasoning import strip_reasoning
from llm_pipeline.main import app
from llm_pipeline.model_catalog import CatalogModel, ModelCatalog
from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.pipeline_config.templates import render
from llm_pipeline.providers import Generation, ModelSpec
from llm_pipeline.settings import settings

# Asks a run to stream its progress as Server-Sent Events.
STREAM = {"Accept": "text/event-stream"}

CREATE = {"If-None-Match": "*"}  # a save creates only if the pipeline is new


class _Recorder:
    """Records every call (spec, prompt, system) and answers per model."""

    def __init__(self, answers: dict[str, str] | None = None) -> None:
        self.calls: list[tuple[ModelSpec, str, str | None]] = []
        self.answers = answers or {}

    def provider_for(self, spec: ModelSpec) -> Any:
        recorder = self

        class _Provider:
            async def generate(self, prompt: str, system: str | None = None) -> Generation:
                recorder.calls.append((spec, prompt, system))
                return Generation(recorder.answers.get(spec.model, f"<{spec.model}>"))

        return _Provider()


def _write(dirpath: Path, definition: dict[str, Any]) -> None:
    PipelineDefinition.model_validate(definition)  # fail fast on a bad fixture
    (dirpath / f"{definition['name']}.yaml").write_text(yaml.safe_dump(definition, sort_keys=False))


@pytest.fixture
def pipelines(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "pipelines_dir", str(tmp_path))
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(settings, "pipeline_editing_enabled", True)
    monkeypatch.setattr(settings, "cors_allowed_origins", "http://localhost:5173")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))
    return tmp_path


@pytest.fixture
def client(pipelines: Path) -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _sse(text: str) -> list[tuple[str, dict[str, Any]]]:
    events = []
    for block in text.strip().split("\n\n"):
        lines = block.split("\n")
        kind = next(line[6:].strip() for line in lines if line.startswith("event:"))
        data = next(line[5:].strip() for line in lines if line.startswith("data:"))
        events.append((kind, json.loads(data)))
    return events


# -- node defaults ---------------------------------------------------------------


def test_nodes_inherit_the_pipeline_defaults(
    client: TestClient, pipelines: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(
        pipelines,
        {
            "name": "defaults",
            "defaults": {
                "model": {
                    "provider": "ollama",
                    "name": "base",
                    "temperature": 0.6,
                    "options": {"num_ctx": 4096, "keep_alive": "10m"},
                },
                "system_prompt": "Be kind.",
            },
            "nodes": [
                # inherits everything
                {"id": "a", "prompt_template": "{{ input }}"},
                # own model: inherits temperature and merges Ollama options
                {
                    "id": "b",
                    "depends_on": ["a"],
                    "model": {"provider": "ollama", "name": "own", "options": {"num_ctx": 8192}},
                    "system_prompt": "Be brief.",
                    "prompt_template": "{{ a.output }}",
                },
            ],
            "output_nodes": ["b"],
        },
    )
    recorder = _Recorder()
    monkeypatch.setattr(node_types_module, "get_provider", recorder.provider_for)
    assert client.post("/v1/workflows/defaults/runs", json={"prompt": "hi"}).status_code == 200

    (spec_a, _, system_a), (spec_b, _, system_b) = recorder.calls
    assert (spec_a.model, spec_a.temperature, system_a) == ("base", 0.6, "Be kind.")
    assert spec_a.options is not None and spec_a.options.num_ctx == 4096
    assert (spec_b.model, spec_b.temperature, system_b) == ("own", 0.6, "Be brief.")
    assert spec_b.options is not None
    assert (spec_b.options.num_ctx, spec_b.options.keep_alive) == (8192, "10m")


def test_a_node_needs_its_own_model_or_a_default() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="node 'a' has no model"):
        PipelineDefinition.model_validate(
            {
                "name": "x",
                "nodes": [{"id": "a", "prompt_template": "{{ input }}"}],
                "output_nodes": ["a"],
            }
        )


@pytest.mark.parametrize("name", ["message", "conversation", "history", "input", "question"])
def test_reserved_node_ids_are_rejected(name: str) -> None:
    """Each is a template variable, which a node's output can't shadow."""
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="reserved"):
        PipelineDefinition.model_validate(
            {
                "name": "x",
                "nodes": [
                    {
                        "id": name,
                        "model": {"provider": "ollama", "name": "m"},
                        "prompt_template": "{{ message }}",
                    }
                ],
                "output_nodes": [name],
            }
        )


# -- history per node, question/history variables, remembered outputs ------------


def _classifier_pipeline(**history: Any) -> dict[str, Any]:
    return {
        "name": "chat",
        "defaults": {"model": {"provider": "ollama", "name": "m"}},
        "history": {"remember": ["classify"], **history},
        "nodes": [
            {
                "id": "classify",
                "include_history": False,
                "prompt_template": "Classify: {{ input }}",
            },
            {
                "id": "answer",
                "depends_on": ["classify"],
                "prompt_template": (
                    "Q={{ question }}|H={{ history }}|I={{ input }}|C={{ classify.output }}"
                ),
            },
        ],
        "output_nodes": ["answer"],
    }


def test_history_reaches_only_the_nodes_that_include_it(
    client: TestClient, pipelines: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(pipelines, _classifier_pipeline())
    recorder = _Recorder({"m": "JOKE"})
    monkeypatch.setattr(node_types_module, "get_provider", recorder.provider_for)
    history = [{"prompt": "earlier", "final_answer": "ok", "outputs": {"classify": "OTHER"}}]
    body = client.post(
        "/v1/workflows/chat/runs", json={"prompt": "tell one", "history": history}
    ).json()

    classify_prompt, answer_prompt = recorder.calls[0][1], recorder.calls[1][1]
    assert classify_prompt == "Classify: tell one"  # no history for this node
    assert "Q=tell one|" in answer_prompt
    assert "H=User: earlier\nclassify: OTHER\nAssistant: ok|" in answer_prompt
    assert "I=Conversation so far:\nUser: earlier" in answer_prompt
    # The classifier's output is handed back to be remembered with this turn.
    assert body["remembered"] == {"classify": "JOKE"}


def test_message_and_conversation_say_what_they_hold(
    client: TestClient, pipelines: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """{{ message }} is the new message alone; {{ conversation }} is the
    earlier turns and then it — or just it, for a node that doesn't see the
    history. {{ question }} and {{ input }} are their older names."""
    definition = _classifier_pipeline()
    definition["nodes"][0]["prompt_template"] = "Classify: {{ conversation }}"
    definition["nodes"][1]["prompt_template"] = (
        "M={{ message }}|Q={{ question }}|V={{ conversation }}|I={{ input }}"
    )
    _write(pipelines, definition)
    recorder = _Recorder({"m": "JOKE"})
    monkeypatch.setattr(node_types_module, "get_provider", recorder.provider_for)
    history = [{"prompt": "earlier", "final_answer": "ok"}]
    client.post("/v1/workflows/chat/runs", json={"prompt": "tell one", "history": history})

    classify_prompt, answer_prompt = recorder.calls[0][1], recorder.calls[1][1]
    assert classify_prompt == "Classify: tell one"
    message, question, conversation, contextual = answer_prompt.split("|")
    assert message == "M=tell one" and question == "Q=tell one"
    assert conversation.startswith("V=Conversation so far:\nUser: earlier")
    assert conversation.endswith("New request: tell one")
    assert conversation[2:] == contextual[2:]


def test_streamed_runs_also_report_remembered_outputs(
    client: TestClient, pipelines: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(pipelines, _classifier_pipeline())
    monkeypatch.setattr(node_types_module, "get_provider", _Recorder({"m": "STORY"}).provider_for)
    response = client.post(
        "/v1/workflows/chat/runs",
        json={
            "prompt": "x",
        },
        headers=STREAM,
    )
    done = _sse(response.text)[-1]
    assert done[0] == "done" and done[1]["remembered"] == {"classify": "STORY"}


def test_older_turns_are_summarized_with_the_chosen_model(
    client: TestClient, pipelines: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    definition = _classifier_pipeline(summarize={"model": {"provider": "ollama", "name": "small"}})
    definition["history"]["max_turns"] = 1
    _write(pipelines, definition)
    _use_catalog(client)
    summarizer = _Recorder({"small": "they talked about cats"})
    monkeypatch.setattr(runs_module, "get_provider", summarizer.provider_for)
    nodes = _Recorder()
    monkeypatch.setattr(node_types_module, "get_provider", nodes.provider_for)

    history = [{"prompt": f"q{i}", "final_answer": f"a{i}"} for i in range(1, 4)]
    client.post("/v1/workflows/chat/runs", json={"prompt": "now", "history": history})

    ((spec, summary_prompt, _),) = summarizer.calls
    assert spec.model == "small"
    assert "User: q1\nAssistant: a1" in summary_prompt and "q3" not in summary_prompt
    answer_prompt = nodes.calls[1][1]
    assert "Summary of the earlier conversation: they talked about cats" in answer_prompt
    assert "User: q3" in answer_prompt


# -- reasoning, parallelism --------------------------------------------------------


@pytest.mark.parametrize(
    "raw,clean",
    [
        ("<think>hmm</think>\n\nThe answer.", "The answer."),
        ("<THINK>a\nb</THINK>Yes", "Yes"),
        ("half a thought</think> Final.", "Final."),  # opening tag missing
        ("Answer. <think>cut off", "Answer."),  # never closed
        ("No reasoning here.", "No reasoning here."),
    ],
)
def test_strip_reasoning(raw: str, clean: str) -> None:
    assert strip_reasoning(raw) == clean


def test_reasoning_is_stripped_per_pipeline_default_and_node_override(
    client: TestClient, pipelines: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(
        pipelines,
        {
            "name": "think",
            "defaults": {"model": {"provider": "ollama", "name": "m"}, "strip_reasoning": True},
            "nodes": [
                {"id": "a", "prompt_template": "{{ input }}"},
                {"id": "b", "strip_reasoning": False, "prompt_template": "{{ input }}"},
            ],
            "output_nodes": ["a", "b"],
        },
    )
    monkeypatch.setattr(
        node_types_module, "get_provider", _Recorder({"m": "<think>x</think>Done"}).provider_for
    )
    outputs = client.post("/v1/workflows/think/runs", json={"prompt": "q"}).json()["node_outputs"]
    assert outputs["a"]["output"] == "Done"
    assert outputs["b"]["output"] == "<think>x</think>Done"


def test_max_concurrency_limits_parallel_model_calls(
    client: TestClient, pipelines: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    roots = [{"id": f"r{i}", "prompt_template": "{{ input }}"} for i in range(4)]
    base = {
        "defaults": {"model": {"provider": "ollama", "name": "m"}},
        "nodes": [
            *roots,
            {"id": "join", "depends_on": [r["id"] for r in roots], "prompt_template": "x"},
        ],
        "output_nodes": ["join"],
    }
    _write(pipelines, {"name": "limited", "execution": {"max_concurrency": 1}, **base})
    _write(pipelines, {"name": "unlimited", **base})

    def measure(name: str) -> int:
        state = {"now": 0, "peak": 0}

        class _Slow:
            async def generate(self, prompt: str, system: str | None = None) -> Generation:
                state["now"] += 1
                state["peak"] = max(state["peak"], state["now"])
                await asyncio.sleep(0.05)
                state["now"] -= 1
                return Generation("ok")

        monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _Slow())
        assert client.post(f"/v1/workflows/{name}/runs", json={"prompt": "q"}).status_code == 200
        return state["peak"]

    assert measure("limited") == 1
    assert measure("unlimited") == 4


def test_a_run_time_limit_is_off_by_default_and_must_be_positive() -> None:
    base: dict[str, Any] = {
        "name": "p",
        "defaults": {"model": {"provider": "ollama", "name": "m"}},
        "nodes": [{"id": "a", "prompt_template": "{{ input }}"}],
        "output_nodes": ["a"],
    }
    assert PipelineDefinition.model_validate(base).execution.run_timeout_seconds is None
    for limit in (0, -1):
        with pytest.raises(ValueError, match="run_timeout_seconds"):
            PipelineDefinition.model_validate({**base, "execution": {"run_timeout_seconds": limit}})


def test_a_run_past_its_time_limit_is_stopped(
    client: TestClient, pipelines: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Each model call has its own timeout, but a run is many of them —
    retried, some in loops. The run's limit bounds the whole, and stops the
    model call still in flight rather than only answering early."""
    _write(
        pipelines,
        {
            "name": "bounded",
            "execution": {"run_timeout_seconds": 0.2},
            "defaults": {"model": {"provider": "ollama", "name": "m"}},
            "nodes": [{"id": "a", "prompt_template": "{{ input }}"}],
            "output_nodes": ["a"],
        },
    )
    cancelled: list[str] = []

    class _Hangs:
        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            try:
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                cancelled.append(prompt)
                raise
            return Generation("too late")

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _Hangs())

    answered = client.post("/v1/workflows/bounded/runs", json={"prompt": "answered"})
    assert answered.status_code == 504
    assert answered.json()["code"] == "RUN_TIMED_OUT"
    assert "0.2s" in answered.json()["message"]

    streamed = client.post(
        "/v1/workflows/bounded/runs", json={"prompt": "streamed"}, headers=STREAM
    )
    event, data = streamed.text.strip().split("\n\n")[-1].split("\n")
    assert event == "event: error"
    assert json.loads(data.removeprefix("data: "))["code"] == "RUN_TIMED_OUT"

    assert cancelled == ["answered", "streamed"]


# -- allowlist covers default and summarizer models ------------------------------------


def _use_catalog(client: TestClient) -> None:
    async def installed() -> list[CatalogModel]:
        return [CatalogModel(name="m:latest"), CatalogModel(name="small:latest")]

    client.app.state.pipeline_store.catalog = ModelCatalog(  # type: ignore[attr-defined]
        "http://ollama.test", [], fetch_ollama_models=installed
    )


def test_default_and_summarizer_models_must_be_allowed(client: TestClient) -> None:
    _use_catalog(client)
    definition = _classifier_pipeline(summarize={"model": {"provider": "ollama", "name": "big"}})
    response = client.put("/v1/workflows/chat", json={"definition": definition}, headers=CREATE)
    assert response.status_code == 422
    assert "history summarizer" in response.json()["message"]

    definition = _classifier_pipeline()
    definition["defaults"]["model"]["name"] = "unknown"
    response = client.put("/v1/workflows/chat", json={"definition": definition}, headers=CREATE)
    assert response.status_code == 422
    assert "pipeline default model" in response.json()["message"]


# -- template sandbox --------------------------------------------------------------


def test_templates_cannot_reach_python_internals() -> None:
    """Templates come from editor clients: plain Jinja would let one walk
    from a string to every Python class (and from there, run code)."""
    with pytest.raises(SecurityError):
        render("{{ input.__class__.__mro__[1].__subclasses__() }}", {"input": "x"})
    assert render("{{ input | upper }} {% if 1 %}ok{% endif %}", {"input": "x"}) == "X ok"


def test_an_injected_node_template_fails_the_node_instead_of_running(
    client: TestClient, pipelines: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(
        pipelines,
        {
            "name": "evil",
            "defaults": {"model": {"provider": "ollama", "name": "m"}},
            "nodes": [
                {"id": "a", "prompt_template": "{{ input.__class__.__mro__[1].__subclasses__() }}"}
            ],
            "output_nodes": ["a"],
        },
    )
    recorder = _Recorder()
    monkeypatch.setattr(node_types_module, "get_provider", recorder.provider_for)
    response = client.post("/v1/workflows/evil/runs", json={"prompt": "x"})
    assert response.status_code == 502
    # A template the sandbox refuses fails its node, like any node failure —
    # not an internal error, and named so an editor can point at it.
    assert response.json()["code"] == "PIPELINE_RUN_FAILED"
    assert response.json()["details"] == {"node_id": "a"}
    assert recorder.calls == []  # the model was never called with the payload
