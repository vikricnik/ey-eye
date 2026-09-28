"""Classifier nodes: `labels` turns a node's free-text answer into exactly
one of a fixed set of labels, so branches can route on it reliably."""

from typing import Any

import pytest
from pydantic import ValidationError

from llm_pipeline.dag_builder import NodeServices, build_graph
from llm_pipeline.dag_builder.labels import match_label
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.providers import Generation

LABELS = ["REFUND", "TECHNICAL", "GENERAL"]


@pytest.mark.parametrize(
    "answer,expected",
    [
        ("REFUND", "REFUND"),
        ("  refund.\n", "REFUND"),
        ('"Technical"', "TECHNICAL"),
        ("**GENERAL**", "GENERAL"),
        ("REFUND\n\nThe customer wants their money back.", "REFUND"),
        ("I'd say this is a technical problem.", "TECHNICAL"),
        ("<think>refund or general?</think>\nGENERAL", "GENERAL"),
    ],
)
def test_answer_is_matched_to_one_label(answer: str, expected: str) -> None:
    assert match_label(answer, LABELS) == expected


@pytest.mark.parametrize(
    "answer",
    [
        "no idea",
        "Either REFUND or GENERAL, hard to tell.",  # two labels: ambiguous
        "REFUNDED",  # not the word itself
    ],
)
def test_answer_matching_no_single_label_is_rejected(answer: str) -> None:
    assert match_label(answer, LABELS) is None


def _router(labels: list[str], routes: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    def node(node_id: str) -> dict[str, Any]:
        return {"id": node_id, "prompt_template": f"{node_id}: {{{{ input }}}}"}

    return {
        "name": "router",
        "defaults": {"model": {"provider": "ollama", "name": "m"}},
        "nodes": [
            {**node("classify"), "labels": labels},
            node("refund_flow"),
            node("general_flow"),
        ],
        "branches": [
            {
                "id": "by_intent",
                "from": "classify",
                "routes": routes
                or [
                    {"when": 'output == "REFUND"', "to": "refund_flow"},
                    {"default": True, "to": "general_flow"},
                ],
            }
        ],
        "output_nodes": ["refund_flow", "general_flow"],
    }


class _Answers:
    """The classifier answers `classifier_answer`; every other node echoes."""

    def __init__(self, classifier_answer: str) -> None:
        self.classifier_answer = classifier_answer

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        return Generation(
            self.classifier_answer if prompt.startswith("classify") else f"out({prompt})"
        )


async def _run(definition: PipelineDefinition, provider: _Answers) -> dict[str, Any]:
    services = NodeServices(provider_factory=lambda spec: provider)
    result = await build_graph(definition, services).ainvoke(
        {"input": "hi", "contextual_input": "hi", "node_outputs": {}, "loop_counts": {}}
    )
    outputs: dict[str, Any] = result["node_outputs"]
    return outputs


@pytest.mark.asyncio
async def test_classifier_output_is_the_matched_label_and_routes_on_it() -> None:
    definition = PipelineDefinition.model_validate(_router(LABELS))
    provider = _Answers("Refund.\nThey were charged twice.")

    outputs = await _run(definition, provider)

    assert outputs["classify"]["output"] == "REFUND"
    assert "refund_flow" in outputs
    assert "general_flow" not in outputs


@pytest.mark.asyncio
async def test_classifier_answer_matching_no_label_fails_naming_the_node() -> None:
    definition = PipelineDefinition.model_validate(_router(LABELS))
    provider = _Answers("I cannot help with that")

    with pytest.raises(PipelineExecutionError, match="none of its labels") as excinfo:
        await _run(definition, provider)
    assert excinfo.value.node_id == "classify"


@pytest.mark.parametrize(
    "labels,message",
    [
        (["ONLY"], "at least 2"),
        (["REFUND", "refund"], "more than once"),
        (["REFUND", "  "], "empty"),
    ],
)
def test_invalid_label_lists_are_rejected(labels: list[str], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        PipelineDefinition.model_validate(_router(labels))


def test_route_that_no_label_can_take_is_rejected() -> None:
    routes: list[dict[str, Any]] = [
        {"when": 'output == "REFUNDS"', "to": "refund_flow"},  # typo: never matches
        {"default": True, "to": "general_flow"},
    ]
    with pytest.raises(ValidationError, match="can never be taken"):
        PipelineDefinition.model_validate(_router(LABELS, routes))


def test_route_that_also_depends_on_the_question_is_not_judged_by_labels_alone() -> None:
    """Whether `output == "REFUND" and "order" in question` matches depends
    on the message, so the load-time check can't call it unreachable — nor
    assume it always catches REFUND before later routes."""
    for name in ("question", "message"):
        routes: list[dict[str, Any]] = [
            {"when": f'output == "REFUND" and "order" in {name}', "to": "refund_flow"},
            {"when": 'output == "REFUND"', "to": "general_flow"},
            {"default": True, "to": "general_flow"},
        ]
        PipelineDefinition.model_validate(_router(LABELS, routes))  # does not raise
