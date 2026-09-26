"""Load-time checks for prompts that use an output which is sometimes
missing when the node runs — caught when the pipeline is loaded or edited,
not by a request failing halfway."""

from typing import Any

import pytest
from pydantic import ValidationError

from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.pipeline_config.templates import unguarded_references

NAMES = {"a", "b"}


@pytest.mark.parametrize(
    "template,expected",
    [
        ("{{ a.output }} {{ b.output }}", {"a", "b"}),
        ("{% if a is defined %}{{ a.output }}{% endif %}", set()),
        ("{% if a is defined and b is defined %}{{ a.output }}{{ b.output }}{% endif %}", set()),
        ("{% if a is defined %}x{% else %}{{ a.output }}{% endif %}", {"a"}),
        (
            "{% if b is defined %}{{ b.output }}{% elif a is defined %}{{ a.output }}{% endif %}",
            set(),
        ),
        ("{% if a is defined %}{{ b.output }}{% endif %}", {"b"}),
        ("{{ a.output if a is defined else '' }}", set()),
        ("{% if a is defined or b is defined %}{{ a.output }}{% endif %}", {"a"}),
        ("{{ input }} {{ question }}", set()),
    ],
)
def test_references_outside_an_is_defined_guard_are_found(
    template: str, expected: set[str]
) -> None:
    assert unguarded_references(template, NAMES) == expected


def _definition(**rest: Any) -> dict[str, Any]:
    return {"name": "p", "defaults": {"model": {"provider": "ollama", "model": "m"}}, **rest}


def _branch_join(summary_template: str) -> dict[str, Any]:
    return _definition(
        nodes=[
            {"id": "classify", "prompt_template": "{{ input }}"},
            {"id": "path_a", "prompt_template": "a"},
            {"id": "path_b", "prompt_template": "b"},
            {
                "id": "summary",
                "depends_on": ["path_a", "path_b"],
                "prompt_template": summary_template,
            },
        ],
        branches=[
            {
                "id": "b",
                "from": "classify",
                "routes": [
                    {"when": '"A" in output', "to": "path_a"},
                    {"default": True, "to": "path_b"},
                ],
            }
        ],
        output_node="summary",
    )


def test_join_after_different_routes_must_guard_each_route_output() -> None:
    only_a_guarded = "{% if path_a is defined %}{{ path_a.output }}{% endif %}{{ path_b.output }}"
    with pytest.raises(ValidationError, match="summary.*path_b.*is defined"):
        PipelineDefinition.model_validate(_branch_join(only_a_guarded))


def test_join_after_different_routes_with_guards_is_accepted() -> None:
    guarded = (
        "{% if path_a is defined %}{{ path_a.output }}{% endif %}"
        "{% if path_b is defined %}{{ path_b.output }}{% endif %}"
    )
    PipelineDefinition.model_validate(_branch_join(guarded))


def test_join_after_one_route_needs_no_guards() -> None:
    """Both targets of the same route always run, and the join waits for both."""
    raw = _branch_join("{{ path_a.output }} {{ path_b.output }}")
    raw["branches"][0]["routes"] = [
        {"when": '"A" in output', "to": ["path_a", "path_b"]},
        {"default": True, "to": "other"},
    ]
    raw["nodes"].append({"id": "other", "prompt_template": "o"})
    raw["output_node"] = ["summary", "other"]
    PipelineDefinition.model_validate(raw)


def _revise_loop(generate_template: str) -> dict[str, Any]:
    return _definition(
        nodes=[
            {"id": "generate", "prompt_template": generate_template},
            {
                "id": "critique",
                "depends_on": ["generate"],
                "prompt_template": "{{ generate.output }}",
            },
        ],
        loops=[
            {
                "id": "revise",
                "from": "critique",
                "back_to": "generate",
                "exit_to": "END",
                "exit_when": 'output.startswith("APPROVE")',
            }
        ],
        output_node="generate",
    )


def test_loop_target_must_guard_the_critique_it_revises_from() -> None:
    """On the first pass the critique hasn't run yet — unguarded, every
    request would fail."""
    with pytest.raises(ValidationError, match="generate.*critique.*first pass"):
        PipelineDefinition.model_validate(_revise_loop("{{ input }} {{ critique.output }}"))


def test_loop_target_with_a_guard_is_accepted() -> None:
    PipelineDefinition.model_validate(
        _revise_loop("{{ input }}{% if critique is defined %}{{ critique.output }}{% endif %}")
    )
