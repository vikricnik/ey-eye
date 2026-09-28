"""Topology: the one place that enumerates what runs after what (CA-001)."""

from typing import Any

import pytest
from pydantic import ValidationError

from llm_pipeline.pipeline_config import IncomingRoute, PipelineDefinition, Topology
from llm_pipeline.rerun import replay_outputs


def _raw(nodes: list[dict[str, Any]], **rest: Any) -> dict[str, Any]:
    return {
        "name": "p",
        "defaults": {"model": {"provider": "ollama", "name": "m"}},
        "nodes": [{"prompt_template": "x", **n} for n in nodes],
        **rest,
    }


def _definition(nodes: list[dict[str, Any]], **rest: Any) -> PipelineDefinition:
    return PipelineDefinition.model_validate(_raw(nodes, **rest))


ROUTED = _definition(
    [{"id": "c"}, {"id": "a"}, {"id": "b"}, {"id": "j", "depends_on": ["a", "b"]}],
    branches=[
        {
            "id": "br",
            "from": "c",
            "routes": [{"when": '"A" in output', "to": ["a", "b"]}, {"default": True, "to": "b"}],
        }
    ],
    output_nodes=["j"],
)

NESTED = _definition(
    [
        {"id": "plan"},
        {"id": "draft", "depends_on": ["plan"]},
        {"id": "check", "depends_on": ["draft"]},
        {"id": "review", "depends_on": ["check"]},  # inner loop's exit, declared on its source
    ],
    loops=[
        {
            "id": "inner",
            "from": "check",
            "back_to": "draft",
            "exit_to": "review",
            "exit_when": "False",
        },
        {
            "id": "outer",
            "from": "review",
            "back_to": "plan",
            "exit_to": "END",
            "exit_when": "False",
        },
    ],
    output_nodes=["review"],
)

# A loop whose way "back" points forward: `polish` declares the loop's source
# as its dependency, so it runs after `draft` — through the loop's edge.
FORWARD_BACK_TO = _definition(
    [
        {"id": "draft"},
        {"id": "polish", "depends_on": ["draft"]},
        {"id": "publish", "depends_on": ["polish"]},
    ],
    loops=[
        {"id": "l", "from": "draft", "back_to": "polish", "exit_to": "END", "exit_when": "True"}
    ],
    output_nodes=["publish"],
)


def test_routes_into_names_every_route_that_starts_a_node() -> None:
    assert Topology(ROUTED).routes_into("b") == (
        IncomingRoute(source_node_id="c", branch_id="br", route_index=0),
        IncomingRoute(source_node_id="c", branch_id="br", route_index=1),
    )


def test_successors_follow_depends_on_routes_and_loop_exits() -> None:
    topology = Topology(NESTED)
    assert topology.successors("plan") == {"draft"}
    assert topology.successors("check") == {"review"}  # the loop's exit, not a plain edge
    assert topology.successors("review") == set()  # exit to END is not a node


def test_a_forward_back_to_is_an_edge_after_the_loop_source() -> None:
    topology = Topology(FORWARD_BACK_TO)
    assert topology.reachable_from("draft") == {"draft", "polish", "publish"}


def test_rerun_from_a_loop_source_reruns_its_forward_back_to() -> None:
    previous = {"draft": "d", "polish": "p", "publish": "q"}
    assert replay_outputs(FORWARD_BACK_TO, "draft", previous) == {}


def test_loop_scope_stops_at_the_loops_own_exit_but_passes_inner_exits() -> None:
    topology = Topology(NESTED)
    assert topology.loop_scope("inner") == {"draft", "check"}
    assert topology.loop_scope("outer") == {"plan", "draft", "check", "review"}


def test_inner_loops_are_found_in_one_direction_only() -> None:
    topology = Topology(NESTED)
    assert topology.inner_loops("outer") == ("inner",)
    assert topology.inner_loops("inner") == ()


def test_declared_destinations_of_a_branch_and_a_loop_source() -> None:
    assert Topology(ROUTED).declared_destinations("c") == {"a", "b"}
    assert Topology(NESTED).declared_destinations("check") == {"draft", "review"}
    assert Topology(NESTED).declared_destinations("review") == {"plan"}
    assert Topology(NESTED).declared_destinations("plan") == set()  # not a branch/loop source


def test_reachable_from_includes_the_start() -> None:
    assert Topology(ROUTED).reachable_from("a") == {"a", "j"}


def test_the_whole_shape_comes_from_topology() -> None:
    topology = Topology(ROUTED)
    assert topology.effective_roots == ("c",)
    assert topology.branch_targets == {"a", "b"}
    assert topology.conditional_sources == {"c"}
    assert topology.node_ids == ("c", "a", "b", "j")


def test_results_cannot_be_changed_by_callers() -> None:
    topology = Topology(ROUTED)
    assert isinstance(topology.plain_dependencies("j"), tuple)
    assert isinstance(topology.routes_into("b"), tuple)
    assert isinstance(topology.successors("a"), frozenset)
    assert isinstance(topology.reachable_from("a"), frozenset)


@pytest.mark.parametrize(
    "query",
    [
        lambda t: t.plain_dependencies("ghost"),
        lambda t: t.routes_into("ghost"),
        lambda t: t.has_outgoing_edges("ghost"),
        lambda t: t.successors("ghost"),
        lambda t: t.reachable_from("ghost"),
        lambda t: t.declared_destinations("ghost"),
        lambda t: t.loop_scope("ghost"),
        lambda t: t.inner_loops("ghost"),
    ],
)
def test_unknown_ids_raise(query: Any) -> None:
    with pytest.raises(KeyError):
        query(Topology(NESTED))


def test_a_node_named_END_is_not_where_a_loop_exiting_to_END_goes() -> None:
    """`exit_to: END` always ends the run — a node that happens to be named
    END and depends on the loop source would never run, so it's rejected."""
    raw = _raw(
        [{"id": "n1"}, {"id": "n2", "depends_on": ["n1"]}, {"id": "END", "depends_on": ["n2"]}],
        loops=[{"id": "l", "from": "n2", "back_to": "n1", "exit_to": "END", "exit_when": "True"}],
        output_nodes=["n1"],
    )
    with pytest.raises(ValidationError, match="silently unreachable"):
        PipelineDefinition.model_validate(raw)
