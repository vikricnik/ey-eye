"""Branch routes that start several nodes: `to: [a, b]` runs every listed
node, in parallel, when that route is taken."""

from typing import Any

import pytest
from pydantic import ValidationError

from llm_pipeline.dag_builder import NodeServices, build_graph
from llm_pipeline.pipeline_config import PipelineDefinition, Topology
from llm_pipeline.pipeline_store import definition_to_yaml, parse_definition_yaml
from llm_pipeline.rerun import downstream


def _definition(
    technical_to: Any, extra_nodes: list[dict[str, Any]] | None = None
) -> dict[str, Any]:
    def node(node_id: str, **fields: Any) -> dict[str, Any]:
        return {"id": node_id, "prompt_template": f"{node_id}: {{{{ input }}}}", **fields}

    return {
        "name": "fan-out-router",
        "defaults": {"model": {"provider": "ollama", "model": "m"}},
        "nodes": [
            node("classify"),
            node("tech_answer"),
            node("security_check"),
            node("general_flow"),
            *(extra_nodes or []),
        ],
        "branches": [
            {
                "id": "by_intent",
                "from": "classify",
                "routes": [
                    {"when": '"TECHNICAL" in output', "to": technical_to},
                    {"default": True, "to": "general_flow"},
                ],
            }
        ],
        "output_node": ["tech_answer", "general_flow"],
    }


class _Answers:
    def __init__(self, classifier_answer: str) -> None:
        self.classifier_answer = classifier_answer
        self.prompts: list[str] = []

    async def generate(self, prompt: str, system: str | None = None) -> str:
        self.prompts.append(prompt)
        return self.classifier_answer if prompt.startswith("classify") else f"out({prompt})"


async def _run(definition: PipelineDefinition, provider: _Answers) -> dict[str, Any]:
    services = NodeServices(provider_factory=lambda spec: provider)
    result = await build_graph(definition, services).ainvoke(
        {"input": "hi", "contextual_input": "hi", "node_outputs": {}, "loop_counts": {}}
    )
    outputs: dict[str, Any] = result["node_outputs"]
    return outputs


def test_route_accepts_a_single_target_or_a_list() -> None:
    single = PipelineDefinition.model_validate(_definition("tech_answer"))
    several = PipelineDefinition.model_validate(_definition(["tech_answer", "security_check"]))

    assert single.branches[0].routes[0].targets == ["tech_answer"]
    assert several.branches[0].routes[0].targets == ["tech_answer", "security_check"]
    assert Topology(several).branch_targets == {"tech_answer", "security_check", "general_flow"}
    assert Topology(several).effective_roots == ("classify",)


@pytest.mark.asyncio
async def test_taken_route_runs_every_target() -> None:
    definition = PipelineDefinition.model_validate(_definition(["tech_answer", "security_check"]))
    provider = _Answers("TECHNICAL")

    outputs = await _run(definition, provider)

    assert set(outputs) == {"classify", "tech_answer", "security_check"}


@pytest.mark.asyncio
async def test_other_route_runs_none_of_the_fanned_out_targets() -> None:
    definition = PipelineDefinition.model_validate(_definition(["tech_answer", "security_check"]))
    provider = _Answers("something else")

    outputs = await _run(definition, provider)

    assert set(outputs) == {"classify", "general_flow"}


@pytest.mark.asyncio
async def test_node_joining_the_targets_of_one_route_runs_once_after_both() -> None:
    combine = {
        "id": "combine",
        "depends_on": ["tech_answer", "security_check"],
        "prompt_template": "combine {{ tech_answer.output }} | {{ security_check.output }}",
    }
    raw = _definition(["tech_answer", "security_check"], [combine])
    raw["output_node"] = ["combine", "general_flow"]
    definition = PipelineDefinition.model_validate(raw)
    provider = _Answers("TECHNICAL")

    outputs = await _run(definition, provider)

    assert [p for p in provider.prompts if p.startswith("combine")] == [
        "combine out(tech_answer: hi) | out(security_check: hi)"
    ]
    assert "combine" in outputs


@pytest.mark.parametrize(
    "to,message",
    [
        ([], "at least one"),
        (["tech_answer", "tech_answer"], "more than once"),
        (["tech_answer", "nowhere"], "routes to unknown node 'nowhere'"),
    ],
)
def test_invalid_target_lists_are_rejected(to: Any, message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        PipelineDefinition.model_validate(_definition(to))


def test_rerun_from_the_branch_source_reaches_every_target() -> None:
    definition = PipelineDefinition.model_validate(_definition(["tech_answer", "security_check"]))
    assert downstream(definition, "classify") == {
        "classify",
        "tech_answer",
        "security_check",
        "general_flow",
    }


def test_target_list_survives_a_yaml_round_trip() -> None:
    definition = PipelineDefinition.model_validate(_definition(["tech_answer", "security_check"]))

    reloaded = parse_definition_yaml(definition_to_yaml(definition))

    routes = reloaded.branches[0].routes
    assert routes[0].to == ["tech_answer", "security_check"]
    assert routes[1].to == "general_flow"  # a single target stays a plain string
