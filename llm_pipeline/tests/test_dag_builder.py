from pathlib import Path
from typing import Any

import pytest
import yaml

import llm_pipeline.dag_builder.node_types as node_types_module
from llm_pipeline.dag_builder import build_graph
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.pipeline_config import PipelineDefinition, load_pipeline_definition
from llm_pipeline.providers import LLMProvider, ModelSpec

FIXTURES_DIR = Path(__file__).parent / "fixtures" / "valid"


class _EchoProvider:
    """Returns a deterministic string identifying which node/prompt it saw,
    so tests can assert on actual execution order and template resolution."""

    def __init__(self, tag: str) -> None:
        self.tag = tag

    async def generate(self, prompt: str, system: str | None = None) -> str:
        return f"[{self.tag}]:{prompt}"


class _FailingProvider:
    async def generate(self, prompt: str, system: str | None = None) -> str:
        raise RuntimeError("simulated failure")


class _SequencedProvider:
    """Returns successive responses from a fixed list, one per call —
    repeats the final entry if called more times than the list has. Used to
    simulate a critique node that says REVISE a couple of times before
    finally saying APPROVE, across a loop's iterations."""

    def __init__(self, responses: list[str]) -> None:
        self.responses = responses
        self.call_count = 0

    async def generate(self, prompt: str, system: str | None = None) -> str:
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
    definition = load_pipeline_definition(FIXTURES_DIR.parent / "pipelines" / "consensus-qa.yaml")

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
    assert set(outputs.keys()) == {"answer_local", "answer_b", "answer_c", "reconcile"}
    assert "what year is it" in outputs["answer_local"]["output"]
    assert "what year is it" in outputs["answer_b"]["output"]
    assert "what year is it" in outputs["answer_c"]["output"]
    assert outputs["answer_local"]["output"] in outputs["reconcile"]["output"]
    assert outputs["answer_b"]["output"] in outputs["reconcile"]["output"]
    assert outputs["answer_c"]["output"] in outputs["reconcile"]["output"]


@pytest.mark.asyncio
async def test_branch_only_runs_the_matching_route(monkeypatch: pytest.MonkeyPatch) -> None:
    """simple_branch.yaml: classify's output decides between path_a/path_b —
    confirms ONLY the matching route actually executes, not both, and the
    non-matching sibling never appears in node_outputs at all."""
    definition = load_pipeline_definition(FIXTURES_DIR / "simple_branch.yaml")

    class _ClassifierProvider:
        async def generate(self, prompt: str, system: str | None = None) -> str:
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
        async def generate(self, prompt: str, system: str | None = None) -> str:
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
    import os
    import tempfile

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


class _RecordingProvider:
    """Answers `out(<prompt>)` and records every prompt it was sent."""

    def __init__(self) -> None:
        self.prompts: list[str] = []

    async def generate(self, prompt: str, system: str | None = None) -> str:
        self.prompts.append(prompt)
        return f"out({prompt})"


@pytest.mark.asyncio
async def test_join_waits_for_all_dependencies_on_uneven_paths(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """J depends on A (one step away) and B2 (two steps away): J must run
    once, after both — not as soon as A finishes and then again."""
    definition = load_pipeline_definition(FIXTURES_DIR / "uneven_join.yaml")
    provider = _RecordingProvider()
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: provider)

    result = await build_graph(definition).ainvoke(
        {"input": "hello", "contextual_input": "hello", "node_outputs": {}, "loop_counts": {}}
    )

    join_prompts = [p for p in provider.prompts if p.startswith("join")]
    assert join_prompts == ["join out(a) + out(b2)"]
    assert result["node_outputs"]["J"]["output"] == "out(join out(a) + out(b2))"


@pytest.mark.asyncio
async def test_join_after_exclusive_branch_routes_runs_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """summary depends on both routes of a branch, but only one route ever
    runs — summary must still run (once), not wait for the other."""
    definition = load_pipeline_definition(FIXTURES_DIR / "branch_join.yaml")
    provider = _RecordingProvider()
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: provider)

    result = await build_graph(definition).ainvoke(
        {"input": "A", "contextual_input": "A", "node_outputs": {}, "loop_counts": {}}
    )

    outputs = result["node_outputs"]
    assert "path_b" not in outputs
    assert outputs["summary"]["output"] == "out(out(A: A))"
    assert len(provider.prompts) == 3  # classify, path_a, summary


@pytest.mark.asyncio
async def test_prompt_referencing_an_output_that_did_not_run_yet_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`join` runs after whichever input arrives (one is re-run by the loop,
    one runs once), and on the first pass `generate` arrives a step before
    `side2` has run. Load-time validation can't know that timing, so the
    run must fail naming the node — not send a prompt with part missing."""
    definition = _from_nodes(
        [
            {"id": "generate", "prompt_template": "gen"},
            {"id": "side", "prompt_template": "side"},
            {"id": "side2", "depends_on": ["side"], "prompt_template": "side2"},
            {
                "id": "join",
                "depends_on": ["generate", "side2"],
                "prompt_template": "join {{ generate.output }} {{ side2.output }}",
            },
            {"id": "critique", "depends_on": ["join"], "prompt_template": "critique"},
        ],
        loops=[_REVISE_LOOP],
        output_node="join",
    )
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _CritiqueProvider())

    with pytest.raises(PipelineExecutionError, match="side2") as excinfo:
        await build_graph(definition).ainvoke(
            {"input": "x", "contextual_input": "x", "node_outputs": {}, "loop_counts": {}}
        )
    assert excinfo.value.node_id == "join"


def _from_nodes(nodes: list[dict[str, Any]], **rest: Any) -> PipelineDefinition:
    return PipelineDefinition.model_validate(
        {
            "name": "p",
            "defaults": {"model": {"provider": "ollama", "model": "m"}},
            "nodes": nodes,
            **rest,
        }
    )


class _CritiqueProvider:
    """Echoes every prompt; `critique` answers REVISE, then APPROVE."""

    def __init__(self) -> None:
        self.prompts: list[str] = []
        self.critiques = 0

    async def generate(self, prompt: str, system: str | None = None) -> str:
        self.prompts.append(prompt)
        if prompt.startswith("critique"):
            self.critiques += 1
            return "REVISE" if self.critiques == 1 else "APPROVE"
        return f"out({prompt})"


_REVISE_LOOP = {
    "id": "revise",
    "from": "critique",
    "back_to": "generate",
    "exit_to": "END",
    "exit_when": 'output.startswith("APPROVE")',
}


@pytest.mark.asyncio
async def test_join_after_one_route_with_uneven_paths_waits_for_both(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """classify routes to [tech, sec] together; tech has one more step
    (polish) before combine — combine must still run once, after both."""
    definition = _from_nodes(
        [
            {"id": "classify", "prompt_template": "T"},
            {"id": "tech", "prompt_template": "tech"},
            {"id": "polish", "depends_on": ["tech"], "prompt_template": "polish"},
            {"id": "sec", "prompt_template": "sec"},
            {
                "id": "combine",
                "depends_on": ["polish", "sec"],
                "prompt_template": "combine {{ polish.output }} {{ sec.output }}",
            },
            {"id": "other", "prompt_template": "other"},
        ],
        branches=[
            {
                "id": "b",
                "from": "classify",
                "routes": [
                    {"when": '"T" in output', "to": ["tech", "sec"]},
                    {"default": True, "to": "other"},
                ],
            }
        ],
        output_node=["combine", "other"],
    )
    provider = _RecordingProvider()
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: provider)

    await build_graph(definition).ainvoke(
        {"input": "x", "contextual_input": "x", "node_outputs": {}, "loop_counts": {}}
    )

    assert [p for p in provider.prompts if p.startswith("combine")] == [
        "combine out(polish) out(sec)"
    ]


@pytest.mark.asyncio
async def test_join_inside_a_loop_waits_for_both_inputs_on_every_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """generate -> a1 -> a2 and generate -> b1 join at `join`, all re-run by
    the loop: each pass must run `join` once, after both a2 and b1."""
    definition = _from_nodes(
        [
            {"id": "generate", "prompt_template": "gen"},
            {"id": "a1", "depends_on": ["generate"], "prompt_template": "a1"},
            {"id": "a2", "depends_on": ["a1"], "prompt_template": "a2"},
            {"id": "b1", "depends_on": ["generate"], "prompt_template": "b1"},
            {
                "id": "join",
                "depends_on": ["a2", "b1"],
                "prompt_template": "join {{ a2.output }} {{ b1.output }}",
            },
            {"id": "critique", "depends_on": ["join"], "prompt_template": "critique"},
        ],
        loops=[_REVISE_LOOP],
        output_node="join",
    )
    provider = _CritiqueProvider()
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: provider)

    await build_graph(definition).ainvoke(
        {"input": "x", "contextual_input": "x", "node_outputs": {}, "loop_counts": {}}
    )

    assert [p for p in provider.prompts if p.startswith("join")] == ["join out(a2) out(b1)"] * 2
    assert provider.critiques == 2


@pytest.mark.asyncio
async def test_join_of_a_looped_and_a_run_once_input_still_runs_on_every_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`side` runs once, `generate` on every pass: waiting for both on the
    second pass would wait forever, so `join` must not."""
    definition = _from_nodes(
        [
            {"id": "generate", "prompt_template": "gen"},
            {"id": "side", "prompt_template": "side"},
            {
                "id": "join",
                "depends_on": ["generate", "side"],
                "prompt_template": "join {{ generate.output }} {{ side.output }}",
            },
            {"id": "critique", "depends_on": ["join"], "prompt_template": "critique"},
        ],
        loops=[_REVISE_LOOP],
        output_node="join",
    )
    provider = _CritiqueProvider()
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: provider)

    await build_graph(definition).ainvoke(
        {"input": "x", "contextual_input": "x", "node_outputs": {}, "loop_counts": {}}
    )

    assert provider.critiques == 2
    assert len([p for p in provider.prompts if p.startswith("join")]) == 2


@pytest.mark.asyncio
async def test_nested_loop_gets_its_full_budget_on_every_outer_pass(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """outer: plan -> ... -> review, back to plan (1 extra pass).
    inner: draft -> check, back to draft (2 extra passes), exits to review.
    Nobody ever approves, so every loop runs to its limit: `check` runs
    3 times per outer pass — also on the second one — and `review` twice.
    The inner loop never resets the outer one (that would never end)."""
    definition = _from_nodes(
        [
            {"id": "plan", "prompt_template": "plan"},
            {"id": "draft", "depends_on": ["plan"], "prompt_template": "draft"},
            {"id": "check", "depends_on": ["draft"], "prompt_template": "check"},
            {"id": "review", "depends_on": ["check"], "prompt_template": "review"},
        ],
        loops=[
            {
                "id": "inner",
                "from": "check",
                "back_to": "draft",
                "exit_to": "review",
                "exit_when": 'output.startswith("APPROVE")',
                "max_iterations": 2,
            },
            {
                "id": "outer",
                "from": "review",
                "back_to": "plan",
                "exit_to": "END",
                "exit_when": 'output.startswith("APPROVE")',
                "max_iterations": 1,
            },
        ],
        output_node="review",
    )
    provider = _RecordingProvider()
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: provider)

    result = await build_graph(definition).ainvoke(
        {"input": "x", "contextual_input": "x", "node_outputs": {}, "loop_counts": {}}
    )

    assert provider.prompts.count("check") == 6
    assert provider.prompts.count("review") == 2
    assert result["loop_counts"] == {"inner": 2, "outer": 1}


@pytest.mark.asyncio
async def test_branch_can_route_on_the_question(monkeypatch: pytest.MonkeyPatch) -> None:
    """`question` is the new message itself — routing on it needs no
    classifier call to repeat what the user wrote."""
    definition = _from_nodes(
        [
            {"id": "triage", "prompt_template": "triage"},
            {"id": "escalate", "prompt_template": "escalate"},
            {"id": "answer", "prompt_template": "answer"},
        ],
        branches=[
            {
                "id": "b",
                "from": "triage",
                "routes": [
                    {"when": '"URGENT" in question', "to": "escalate"},
                    {"default": True, "to": "answer"},
                ],
            }
        ],
        output_node=["escalate", "answer"],
    )
    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _RecordingProvider())

    async def run(message: str) -> set[str]:
        result = await build_graph(definition).ainvoke(
            {"input": message, "contextual_input": message, "node_outputs": {}, "loop_counts": {}}
        )
        return set(result["node_outputs"])

    assert await run("URGENT: server down") == {"triage", "escalate"}
    assert await run("how do I reset my password?") == {"triage", "answer"}
