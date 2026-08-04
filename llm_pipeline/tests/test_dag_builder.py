from pathlib import Path
import pytest

import llm_pipeline.dag_builder.node_types as node_types_module
from llm_pipeline.pipeline_config import load_pipeline_definition
from llm_pipeline.dag_builder import build_graph
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.providers import ModelSpec, LLMProvider

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "valid"


class _EchoProvider:
    """Returns a deterministic string identifying which node/prompt it saw,
    so tests can assert on actual execution order and template resolution."""

    def __init__(self, tag: str) -> None:
        self.tag = tag

    async def generate(self, prompt: str) -> str:
        return f"[{self.tag}]:{prompt}"


class _FailingProvider:
    async def generate(self, prompt: str) -> str:
        raise RuntimeError("simulated failure")


class _SequencedProvider:
    """Returns successive responses from a fixed list, one per call —
    repeats the final entry if called more times than the list has. Used to
    simulate a critique node that says REVISE a couple of times before
    finally saying APPROVE, across a loop's iterations."""

    def __init__(self, responses: list[str]) -> None:
        self.responses = responses
        self.call_count = 0

    async def generate(self, prompt: str) -> str:
        idx = min(self.call_count, len(self.responses) - 1)
        response = self.responses[idx]
        self.call_count += 1
        return response


@pytest.mark.asyncio
async def test_diamond_dag_executes_and_joins_correctly(monkeypatch: pytest.MonkeyPatch) -> None:
    """A -> (B, C) -> D: confirms parallel siblings both run and D's join
    correctly sees both of their outputs, purely from the depends_on edges."""
    definition = load_pipeline_definition(FIXTURES_DIR / "diamond.yaml")

    def fake_get_provider(spec: ModelSpec) -> LLMProvider:  # test double, spec shape not needed
        return _EchoProvider(spec.model)

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    graph = build_graph(definition)
    result = await graph.ainvoke(
        {"input": "hello", "contextual_input": "hello", "node_outputs": {}, "loop_counts": {}}
    )

    outputs = result["node_outputs"]
    assert set(outputs.keys()) == {"A", "B", "C", "D"}

    assert outputs["A"]["output"] == "[test-model]:hello"
    assert outputs["B"]["output"] == "[test-model]:[test-model]:hello"
    assert outputs["C"]["output"] == "[test-model]:[test-model]:hello"
    assert "[test-model]:[test-model]:hello" in outputs["D"]["output"]
    assert outputs["D"]["output"].count("[test-model]:[test-model]:hello") == 2


@pytest.mark.asyncio
async def test_node_failure_raises_pipeline_execution_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A DAG node has no generically safe fallback the way an old per-category
    generator did (a downstream node may uniquely depend on it) — a failure
    should surface clearly as PipelineExecutionError, not be silently dropped."""
    definition = load_pipeline_definition(FIXTURES_DIR / "diamond.yaml")

    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        return _FailingProvider()

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    graph = build_graph(definition)

    with pytest.raises(PipelineExecutionError):
        await graph.ainvoke(
            {"input": "hello", "contextual_input": "hello", "node_outputs": {}, "loop_counts": {}}
        )


@pytest.mark.asyncio
async def test_multi_root_pipeline_uses_synthetic_start_node(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """consensus-qa.yaml has 3 independent roots — confirms the synthetic
    __dag_root__ node correctly fans out to all of them and the join still works."""
    pipelines_dir = Path(__file__).parent.parent / "pipelines"
    definition = load_pipeline_definition(pipelines_dir / "consensus-qa.yaml")

    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        return _EchoProvider(spec.identity)

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    graph = build_graph(definition)
    result = await graph.ainvoke(
        {
            "input": "what year is it",
            "contextual_input": "what year is it",
            "node_outputs": {},
            "loop_counts": {},
        }
    )

    outputs = result["node_outputs"]
    assert set(outputs.keys()) == {"answer_local", "answer_gpt", "answer_claude", "reconcile"}
    assert "what year is it" in outputs["answer_local"]["output"]
    assert "what year is it" in outputs["answer_gpt"]["output"]
    assert "what year is it" in outputs["answer_claude"]["output"]
    assert outputs["answer_local"]["output"] in outputs["reconcile"]["output"]
    assert outputs["answer_gpt"]["output"] in outputs["reconcile"]["output"]
    assert outputs["answer_claude"]["output"] in outputs["reconcile"]["output"]


@pytest.mark.asyncio
async def test_branch_only_runs_the_matching_route(monkeypatch: pytest.MonkeyPatch) -> None:
    """simple_branch.yaml: classify's output decides between path_a/path_b —
    confirms ONLY the matching route actually executes, not both, and the
    non-matching sibling never appears in node_outputs at all."""
    definition = load_pipeline_definition(FIXTURES_DIR / "simple_branch.yaml")

    class _ClassifierProvider:
        async def generate(self, prompt: str) -> str:
            return "A"  # matches the `"A" in output` route

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _ClassifierProvider())

    graph = build_graph(definition)
    result = await graph.ainvoke(
        {"input": "hello", "contextual_input": "hello", "node_outputs": {}, "loop_counts": {}}
    )

    outputs = result["node_outputs"]
    assert "classify" in outputs
    assert "path_a" in outputs  # route matched ("A" in output)
    assert "path_b" not in outputs  # the non-matching sibling never ran


@pytest.mark.asyncio
async def test_branch_falls_through_to_default_route(monkeypatch: pytest.MonkeyPatch) -> None:
    """When no `when` condition matches, the default route runs instead."""
    definition = load_pipeline_definition(FIXTURES_DIR / "simple_branch.yaml")

    class _ClassifierProvider:
        async def generate(self, prompt: str) -> str:
            return "neither letter matches"  # doesn't contain "A"

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _ClassifierProvider())

    graph = build_graph(definition)
    result = await graph.ainvoke(
        {"input": "hello", "contextual_input": "hello", "node_outputs": {}, "loop_counts": {}}
    )

    outputs = result["node_outputs"]
    assert "path_b" in outputs  # default route
    assert "path_a" not in outputs


@pytest.mark.asyncio
async def test_loop_revises_until_approved(monkeypatch: pytest.MonkeyPatch) -> None:
    """simple_loop.yaml: critique says REVISE twice, then APPROVE — confirms
    generate re-runs each time (picking up the latest critique feedback via
    the {% if critique is defined %} template guard) and the loop exits
    exactly when exit_when first matches, with the correct iteration count."""
    definition = load_pipeline_definition(FIXTURES_DIR / "simple_loop.yaml")

    critique_provider = _SequencedProvider(["REVISE: fix intro", "REVISE: fix again", "APPROVE"])
    generate_provider = _EchoProvider("gen")

    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        if spec.model == "critique-model":
            return critique_provider
        return generate_provider

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    graph = build_graph(definition)
    result = await graph.ainvoke(
        {
            "input": "draft this",
            "contextual_input": "draft this",
            "node_outputs": {},
            "loop_counts": {},
        }
    )

    outputs = result["node_outputs"]
    # node_outputs only ever holds the LATEST result per node id — confirm
    # it's the final APPROVE, not an earlier REVISE.
    assert outputs["critique"]["output"] == "APPROVE"
    # the loop looped back twice before exiting on the 3rd critique
    assert result["loop_counts"]["loop1"] == 2
    assert "generate" in outputs


@pytest.mark.asyncio
async def test_loop_hits_max_iterations_and_proceeds(monkeypatch: pytest.MonkeyPatch) -> None:
    """If exit_when never matches, on_max_iterations=proceed should still
    complete the pipeline rather than looping forever."""
    definition = load_pipeline_definition(FIXTURES_DIR / "simple_loop.yaml")

    critique_provider = _SequencedProvider(["REVISE: never good enough"])
    generate_provider = _EchoProvider("gen")

    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        if spec.model == "critique-model":
            return critique_provider
        return generate_provider

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    graph = build_graph(definition)
    result = await graph.ainvoke(
        {
            "input": "draft this",
            "contextual_input": "draft this",
            "node_outputs": {},
            "loop_counts": {},
        }
    )

    # max_iterations=3 in the fixture; on_max_iterations=proceed means this
    # completes successfully rather than raising.
    assert result["loop_counts"]["loop1"] == 3
    assert "generate" in result["node_outputs"]


@pytest.mark.asyncio
async def test_loop_hits_max_iterations_and_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    """on_max_iterations=fail should raise PipelineExecutionError once the
    cap is reached without ever meeting exit_when."""
    import yaml
    import tempfile
    import os

    with open(FIXTURES_DIR / "simple_loop.yaml") as f:
        raw = yaml.safe_load(f)
    raw["loops"][0]["on_max_iterations"] = "fail"
    raw["loops"][0]["max_iterations"] = 2

    with tempfile.NamedTemporaryFile(mode="w", suffix=".yaml", delete=False) as tmp:
        yaml.safe_dump(raw, tmp)
        tmp_path = tmp.name

    try:
        definition = load_pipeline_definition(Path(tmp_path))
    finally:
        os.unlink(tmp_path)

    critique_provider = _SequencedProvider(["REVISE: still not good"])
    generate_provider = _EchoProvider("gen")

    def fake_get_provider(spec: ModelSpec) -> LLMProvider:
        if spec.model == "critique-model":
            return critique_provider
        return generate_provider

    monkeypatch.setattr(node_types_module, "get_provider", fake_get_provider)

    graph = build_graph(definition)

    with pytest.raises(PipelineExecutionError, match="exceeded max_iterations"):
        await graph.ainvoke(
            {
                "input": "draft this",
                "contextual_input": "draft this",
                "node_outputs": {},
                "loop_counts": {},
            }
        )
