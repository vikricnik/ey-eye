"""Re-running from a node (reusing the other nodes' previous outputs) and
previewing a node's prompt without running anything."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

import llm_pipeline.dag_builder.node_types as node_types_module
import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.main import app
from llm_pipeline.pipeline_config import load_pipeline_definition
from llm_pipeline.providers import Generation, ModelSpec
from llm_pipeline.rerun import downstream, replay_outputs
from llm_pipeline.settings import settings

# Asks a run to stream its progress as Server-Sent Events.
STREAM = {"Accept": "text/event-stream"}

FIXTURES = Path(__file__).parent / "fixtures" / "pipelines"


class _Calls:
    """Answers per (model, temperature) — enough to tell nodes apart in the
    fixture pipelines — and records which were called with what."""

    def __init__(self, answers: dict[tuple[str, float], list[str]]) -> None:
        self.answers = answers
        self.prompts: dict[tuple[str, float], list[str]] = {}

    def provider_for(self, spec: ModelSpec) -> Any:
        key = (spec.model, spec.temperature)
        calls = self

        class _Provider:
            async def generate(self, prompt: str, system: str | None = None) -> Generation:
                calls.prompts.setdefault(key, []).append(prompt)
                queue = calls.answers.get(key, [])
                return Generation(
                    queue.pop(0) if len(queue) > 1 else (queue[0] if queue else f"<{key[0]}>")
                )

        return _Provider()


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(settings, "pipeline_editing_enabled", True)
    monkeypatch.setattr(settings, "cors_allowed_origins", "http://localhost:5173")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _events(text: str) -> list[tuple[str, dict[str, Any]]]:
    events = []
    for block in text.strip().split("\n\n"):
        lines = block.split("\n")
        kind = next(line[6:].strip() for line in lines if line.startswith("event:"))
        data = next(line[5:].strip() for line in lines if line.startswith("data:"))
        events.append((kind, json.loads(data)))
    return events


# -- which nodes re-run ------------------------------------------------------------


def test_downstream_follows_dependencies_branches_and_loop_exits() -> None:
    consensus = load_pipeline_definition(FIXTURES / "consensus-qa.yaml")
    assert downstream(consensus, "answer_b") == {"answer_b", "reconcile"}
    assert downstream(consensus, "reconcile") == {"reconcile"}

    router = load_pipeline_definition(FIXTURES / "support-router.yaml")
    assert downstream(router, "classify") == {
        "classify",
        "refund_flow",
        "tech_support_flow",
        "general_flow",
    }

    refine = load_pipeline_definition(FIXTURES / "iterative-refinement.yaml")
    # The loop's way back to `generate` isn't "after" critique: generate
    # replays its draft first, then runs for real if the loop comes back.
    assert downstream(refine, "critique") == {"critique"}
    assert replay_outputs(refine, "critique", {"generate": "d", "critique": "c", "gone": "x"}) == {
        "generate": "d"
    }


# -- re-running over HTTP -----------------------------------------------------------


def test_rerun_calls_only_the_node_and_what_follows(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _Calls({("llama3", 0.1): ["new b"], ("llama3", 0.0): ["reconciled"]})
    monkeypatch.setattr(node_types_module, "get_provider", calls.provider_for)
    response = client.post(
        "/v1/workflows/consensus-qa/runs",
        json={
            "prompt": "q",
            "rerun": {
                "from_node": "answer_b",
                "outputs": {
                    "answer_local": "old local",
                    "answer_b": "old b",
                    "answer_c": "old c",
                    "reconcile": "old reconcile",
                },
            },
        },
        headers=STREAM,
    )
    events = _events(response.text)
    assert events[-1][0] == "done"
    # Only answer_b and reconcile called a model.
    assert set(calls.prompts) == {("llama3", 0.1), ("llama3", 0.0)}
    (reconcile_prompt,) = calls.prompts[("llama3", 0.0)]
    assert "old local" in reconcile_prompt and "new b" in reconcile_prompt
    assert "old c" in reconcile_prompt and "old b" not in reconcile_prompt

    starts = {d["node_id"]: d["replayed"] for k, d in events if k == "node_start"}
    assert starts == {"answer_local": True, "answer_c": True, "answer_b": False, "reconcile": False}
    completed = {d["node"]["node_id"]: d["node"] for k, d in events if k == "node_complete"}
    assert completed["answer_c"]["replayed"] is True and completed["answer_c"]["output"] == "old c"
    assert completed["reconcile"]["replayed"] is False
    assert events[-1][1]["final_answer"] == "reconciled"


def test_a_loop_coming_back_to_a_reused_node_runs_it_for_real(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _Calls(
        {
            ("llama3.2:3b", 0.0): ["REVISE: shorter", "APPROVE"],
            ("llama3", 0.4): ["revised draft"],
        }
    )
    monkeypatch.setattr(node_types_module, "get_provider", calls.provider_for)
    response = client.post(
        "/v1/workflows/iterative-refinement/runs",
        json={
            "prompt": "q",
            "rerun": {"from_node": "critique", "outputs": {"generate": "old draft"}},
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["final_answer"] == "revised draft"
    assert len(calls.prompts[("llama3.2:3b", 0.0)]) == 2  # critique: the re-run, then the loop
    (revision_prompt,) = calls.prompts[("llama3", 0.4)]  # generate: only the loop's revision
    assert "REVISE: shorter" in revision_prompt
    assert "old draft" in calls.prompts[("llama3.2:3b", 0.0)][0]


def test_a_reused_branch_source_takes_the_same_route(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = _Calls({("qwen3-coder:30b", 0.2): ["try restarting"]})
    monkeypatch.setattr(node_types_module, "get_provider", calls.provider_for)
    response = client.post(
        "/v1/workflows/support-router/runs",
        json={
            "prompt": "my laptop is broken",
            "rerun": {"from_node": "tech_support_flow", "outputs": {"classify": "TECHNICAL"}},
        },
    )
    assert response.json()["output_node"] == "tech_support_flow"
    assert set(calls.prompts) == {("qwen3-coder:30b", 0.2)}


def test_rerun_from_an_unknown_node_is_rejected(client: TestClient) -> None:
    response = client.post(
        "/v1/workflows/consensus-qa/runs",
        json={"prompt": "q", "rerun": {"from_node": "nope"}},
    )
    assert response.status_code == 404
    assert response.json()["code"] == "NODE_NOT_FOUND"
    assert "no such node" in response.json()["message"]


# -- previews ------------------------------------------------------------------------


def _definition(name: str) -> dict[str, Any]:
    return load_pipeline_definition(FIXTURES / name).model_dump(mode="json", by_alias=True)


def test_preview_renders_what_the_node_would_receive(client: TestClient) -> None:
    definition = _definition("consensus-qa.yaml")
    definition["defaults"] = {"system_prompt": "Be exact."}
    response = client.post(
        "/v1/drafts/prompt-preview",
        json={
            "definition": definition,
            "node_id": "reconcile",
            "prompt": "and in 2020?",
            "history": [{"prompt": "population of Paris?", "final_answer": "2.1 million"}],
            "outputs": {"answer_local": "2.1M", "unrelated": "ignored"},
        },
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["missing"] == ["answer_b", "answer_c"]
    assert body["system"] == "Be exact."
    prompt = body["prompt"]
    assert "2.1M" in prompt and "<answer_b's output>" in prompt
    assert "User: population of Paris?" in prompt and "New request: and in 2020?" in prompt


def test_preview_problems(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    definition = _definition("simple-local.yaml")
    unknown = client.post(
        "/v1/drafts/prompt-preview", json={"definition": definition, "node_id": "x"}
    )
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "NODE_NOT_FOUND"

    definition["nodes"][0]["prompt_template"] = "{{ input.__class__.__mro__ }}"
    unsafe = client.post(
        "/v1/drafts/prompt-preview", json={"definition": definition, "node_id": "answer"}
    )
    assert unsafe.status_code == 422 and "can't be rendered" in unsafe.json()["message"]
    assert unsafe.json()["code"] == "TEMPLATE_RENDER_FAILED"

    monkeypatch.setattr(settings, "pipeline_editing_enabled", False)
    blocked = client.post(
        "/v1/drafts/prompt-preview", json={"definition": definition, "node_id": "answer"}
    )
    assert blocked.status_code == 403
    assert blocked.json()["code"] == "EDITING_DISABLED"
