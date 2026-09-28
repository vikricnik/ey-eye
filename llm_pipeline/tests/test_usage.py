"""Token usage per node: what the backend reported, and how much context the
model had — the node's num_ctx, else what the loaded Ollama model runs with."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

import llm_pipeline.dag_builder.node_types as node_types_module
import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.main import app
from llm_pipeline.model_catalog import ModelCatalog
from llm_pipeline.providers import Generation, ModelSpec, Usage
from llm_pipeline.settings import settings

# Asks a run to stream its progress as Server-Sent Events.
STREAM = {"Accept": "text/event-stream"}

PIPELINE: dict[str, Any] = {
    "name": "usage",
    "nodes": [
        {
            "id": "sized",
            "model": {"provider": "ollama", "name": "big", "options": {"num_ctx": 8192}},
            "prompt_template": "{{ input }}",
        },
        {
            "id": "unsized",
            "depends_on": ["sized"],
            "model": {"provider": "ollama", "name": "small"},
            "prompt_template": "{{ sized.output }}",
        },
        {
            "id": "quiet",
            "depends_on": ["unsized"],
            "model": {"provider": "ollama", "name": "silent"},
            "prompt_template": "{{ unsized.output }}",
        },
    ],
    "output_nodes": ["quiet"],
}


def _provider_for(spec: ModelSpec) -> Any:
    class _Provider:
        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            if spec.model == "silent":
                return Generation("plain text, no usage")  # backends may report nothing
            return Generation(
                f"<{spec.model}>",
                Usage(prompt_tokens=3900, completion_tokens=100, generation_ms=2000.0),
            )

    return _Provider()


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    (tmp_path / "usage.yaml").write_text(yaml.safe_dump(PIPELINE, sort_keys=False))
    monkeypatch.setattr(settings, "pipelines_dir", str(tmp_path))
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))
    monkeypatch.setattr(node_types_module, "get_provider", _provider_for)

    async def running(self: ModelCatalog) -> dict[str, int]:
        return {"small:latest": 4096}

    # Before startup: the app's catalog is handed to every node it builds.
    monkeypatch.setattr(ModelCatalog, "_running_ollama_models", running)
    with TestClient(app) as c:
        yield c


def _usage_by_node(node_outputs: dict[str, Any]) -> dict[str, Any]:
    return {node_id: out["usage"] for node_id, out in node_outputs.items()}


def test_usage_and_context_window_per_node(client: TestClient) -> None:
    response = client.post("/pipelines/usage/runs", json={"prompt": "hi"})
    assert response.status_code == 200
    usage = _usage_by_node(response.json()["node_outputs"])
    assert usage["sized"] == {
        "prompt_tokens": 3900,
        "completion_tokens": 100,
        "generation_ms": 2000.0,
        "context_window": 8192,  # the node's own num_ctx
        "prompt_chars": len("hi"),  # what was sent: the rendered prompt
    }
    assert usage["unsized"]["context_window"] == 4096  # what Ollama runs it with
    assert usage["quiet"] is None


def test_streamed_node_complete_and_done_carry_the_same_usage(client: TestClient) -> None:
    response = client.post(
        "/pipelines/usage/runs",
        json={
            "prompt": "hi",
        },
        headers=STREAM,
    )
    events = []
    for block in response.text.strip().split("\n\n"):
        lines = block.split("\n")
        kind = next(line[6:].strip() for line in lines if line.startswith("event:"))
        data = next(line[5:].strip() for line in lines if line.startswith("data:"))
        events.append((kind, json.loads(data)))
    completed = {
        d["node"]["node_id"]: d["node"]["usage"] for k, d in events if k == "node_complete"
    }
    assert completed["unsized"]["context_window"] == 4096
    done = next(d for k, d in events if k == "done")
    assert _usage_by_node(done["node_outputs"]) == completed


@pytest.mark.asyncio
async def test_running_context_refetches_for_a_model_missing_from_the_snapshot() -> None:
    snapshots = [{"a:latest": 2048}, {"a:latest": 2048, "b:7b": 8192}]
    calls = 0

    async def running() -> dict[str, int]:
        nonlocal calls
        calls += 1
        return snapshots[min(calls - 1, 1)]

    catalog = ModelCatalog(ollama_base_url="http://unused", cloud_models=[], ollama_running=running)
    assert await catalog.running_context("a") == 2048
    assert await catalog.running_context("a:latest") == 2048 and calls == 1  # cached
    assert await catalog.running_context("b:7b") == 8192 and calls == 2  # just loaded

    async def unreachable() -> dict[str, int]:
        raise ConnectionError("ollama down")

    down = ModelCatalog(
        ollama_base_url="http://unused", cloud_models=[], ollama_running=unreachable
    )
    assert await down.running_context("a") is None  # best effort, never raises


@pytest.mark.asyncio
async def test_each_node_asks_for_its_context_right_after_its_own_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two nodes on one Ollama model: the second loads it with a smaller
    num_ctx. Asking once at the end would report the second's context for
    both — each node asks right after its call instead."""
    from llm_pipeline.dag_builder import NodeServices, build_graph
    from llm_pipeline.pipeline_config import PipelineDefinition

    loaded = [4096, 256]  # what Ollama reports after each successive call
    calls: list[str] = []

    async def probe(model: str) -> int | None:
        calls.append(model)
        return loaded[len(calls) - 1]

    definition = PipelineDefinition.model_validate(
        {
            "name": "p",
            "nodes": [
                {
                    "id": "first",
                    "model": {"provider": "ollama", "name": "m"},
                    "prompt_template": "{{ input }}",
                },
                {
                    "id": "second",
                    "depends_on": ["first"],
                    "model": {"provider": "ollama", "name": "m"},
                    "prompt_template": "{{ first.output }}",
                },
            ],
            "output_nodes": ["second"],
        }
    )
    graph = build_graph(
        definition, NodeServices(provider_factory=_provider_for, context_probe=probe)
    )
    state = await graph.ainvoke(
        {
            "input": "hi",
            "contextual_input": "hi",
            "history": "",
            "node_outputs": {},
            "loop_counts": {},
        }
    )
    outputs = state["node_outputs"]
    assert outputs["first"]["usage"]["context_window"] == 4096
    assert outputs["second"]["usage"]["context_window"] == 256
    assert calls == ["m", "m"]
