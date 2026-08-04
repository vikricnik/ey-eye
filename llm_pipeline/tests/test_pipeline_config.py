from pathlib import Path
import pytest
from pydantic import ValidationError

from llm_pipeline.pipeline_config import load_pipeline_definition, list_available_pipelines

FIXTURES_DIR = Path(__file__).parent / "fixtures"
VALID_DIR = FIXTURES_DIR / "valid"
INVALID_DIR = FIXTURES_DIR / "invalid"


def test_diamond_dag_loads_and_resolves_roots() -> None:
    definition = load_pipeline_definition(VALID_DIR / "diamond.yaml")
    assert definition.name == "diamond"
    assert definition.root_node_ids == ["A"]
    assert definition.effective_root_ids == ["A"]
    assert definition.output_node_candidates == ["D"]
    assert {n.id for n in definition.nodes} == {"A", "B", "C", "D"}


def test_simple_loop_fixture_loads() -> None:
    definition = load_pipeline_definition(VALID_DIR / "simple_loop.yaml")
    assert len(definition.loops) == 1
    loop = definition.loops[0]
    assert loop.from_ == "critique"
    assert loop.back_to == "generate"
    assert loop.exit_to == "END"
    # "critique" is a conditional source, so the base DAG's cycle check
    # (which only looks at depends_on) sees no cycle — the actual cycle in
    # the compiled graph comes entirely from the loop mechanism, which is
    # deliberately exempt from that check.
    assert definition.conditional_sources == {"critique"}


def test_simple_branch_fixture_loads() -> None:
    definition = load_pipeline_definition(VALID_DIR / "simple_branch.yaml")
    assert len(definition.branches) == 1
    branch = definition.branches[0]
    assert branch.from_ == "classify"
    assert {r.to for r in branch.routes} == {"path_a", "path_b"}
    # path_a and path_b both have depends_on=[] but must NOT be automatic
    # entry points — only `classify` should be an effective root.
    assert definition.effective_root_ids == ["classify"]
    assert set(definition.root_node_ids) == {"classify", "path_a", "path_b"}


@pytest.mark.parametrize(
    "filename,expected_message_fragment",
    [
        ("cycle.yaml", "cycle detected"),
        ("dangling_dependency.yaml", "depends_on unknown node"),
        ("unresolved_reference.yaml", "doesn't declare"),
        ("missing_output_node.yaml", "is not a defined node id"),
        ("duplicate_ids.yaml", "duplicate node id"),
        ("branch_two_defaults.yaml", "exactly one default route"),
        ("branch_bad_target.yaml", "routes to unknown node"),
        ("loop_bad_back_to.yaml", "back_to unknown node"),
        ("loop_unsafe_expression.yaml", "invalid exit_when"),
        ("conflicting_conditional_edge.yaml", "silently unreachable"),
        ("dual_conditional_source.yaml", "more than one branch/loop"),
    ],
)
def test_invalid_fixtures_raise_clear_errors(
    filename: str, expected_message_fragment: str
) -> None:
    with pytest.raises(ValidationError) as exc_info:
        load_pipeline_definition(INVALID_DIR / filename)
    assert expected_message_fragment in str(exc_info.value)


def test_list_available_pipelines_skips_invalid_files() -> None:
    # Mixed directory: real pipelines dir has only valid files, but this
    # confirms invalid ones are skipped rather than crashing the listing.
    results = list_available_pipelines(INVALID_DIR)
    assert results == []  # every file in invalid/ should fail to load


def test_real_pipeline_examples_are_valid() -> None:
    """Every example pipeline shipped in pipelines/ must itself pass
    validation — this is the same check CI should run on every PR."""
    pipelines_dir = Path(__file__).parent.parent / "pipelines"
    results = list_available_pipelines(pipelines_dir)
    names = {r.name for r in results}
    assert "consensus-qa" in names
    assert "code-review-pipeline" in names
    assert "simple-local" in names
    assert "iterative-refinement" in names
    assert "support-router" in names


def test_support_router_output_node_is_a_list() -> None:
    pipelines_dir = Path(__file__).parent.parent / "pipelines"
    definition = load_pipeline_definition(pipelines_dir / "support-router.yaml")
    assert definition.output_node_candidates == [
        "refund_flow",
        "tech_support_flow",
        "general_flow",
    ]
    assert definition.effective_root_ids == ["classify"]


def test_iterative_refinement_output_node_is_the_loop_back_target() -> None:
    pipelines_dir = Path(__file__).parent.parent / "pipelines"
    definition = load_pipeline_definition(pipelines_dir / "iterative-refinement.yaml")
    assert definition.output_node_candidates == ["generate"]
    assert definition.loops[0].max_iterations == 3
    assert definition.loops[0].on_max_iterations == "proceed"
