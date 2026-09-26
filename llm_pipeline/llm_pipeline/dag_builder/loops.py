from collections.abc import Hashable

from langgraph.graph import END, StateGraph

from llm_pipeline.dag_builder.node_types import LoopIncrementCallable, NodeCallable, RouterCallable
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.pipeline_config import END_SENTINEL, LoopConfig, PipelineDefinition
from llm_pipeline.safe_eval import evaluate_condition
from llm_pipeline.state import NodeResult, PipelineState


def _make_loop_router(loop: LoopConfig) -> RouterCallable:
    def router(state: PipelineState) -> str:
        counts = state.get("loop_counts", {})
        count = counts.get(loop.id, 0)

        if count >= loop.max_iterations:
            return "fail" if loop.on_max_iterations == "fail" else "exit"

        output = state["node_outputs"][loop.from_]["output"]
        if evaluate_condition(loop.exit_when, output, state["input"]):
            return "exit"
        return "loop"

    return router


def _make_loop_increment_node(loop_id: str, nested: list[str]) -> LoopIncrementCallable:
    """Counts one more pass of `loop_id`, and starts every loop nested in
    it over — a nested loop's max_iterations is per pass of the outer loop,
    not for the whole run. Writes only the counters it changes."""

    async def node_fn(state: PipelineState) -> dict[str, dict[str, int]]:
        counts = {inner: 0 for inner in nested}
        counts[loop_id] = state.get("loop_counts", {}).get(loop_id, 0) + 1
        return {"loop_counts": counts}

    return node_fn


def nested_loops(definition: PipelineDefinition) -> dict[str, list[str]]:
    """loop id -> the loops entirely inside it: both their back_to and
    their from_ run again on each of its passes. Two loops that would each
    count as inside the other (possible only through odd branch cycles) are
    left alone — resetting each other, neither would ever run out."""
    forward: dict[str, set[str]] = {n.id: set() for n in definition.nodes}
    for node in definition.nodes:
        for dep in node.depends_on:
            forward[dep].add(node.id)
    for branch in definition.branches:
        forward[branch.from_].update(t for route in branch.routes for t in route.targets)
    exits = {loop.id: loop.exit_to for loop in definition.loops if loop.exit_to != END_SENTINEL}

    def rerun_by(loop: LoopConfig) -> set[str]:
        # Everything after back_to, through other loops' exits, up to (and
        # not past) this loop's own exit.
        reached, pending = set[str](), [loop.back_to]
        while pending:
            node_id = pending.pop()
            if node_id in reached:
                continue
            reached.add(node_id)
            pending.extend(forward[node_id])
            pending.extend(
                exits[other.id]
                for other in definition.loops
                if other.from_ == node_id and other.id != loop.id and other.id in exits
            )
        return reached

    scopes = {loop.id: rerun_by(loop) for loop in definition.loops}

    def inside(inner: LoopConfig, outer: LoopConfig) -> bool:
        scope = scopes[outer.id]
        return inner.id != outer.id and inner.back_to in scope and inner.from_ in scope

    return {
        outer.id: [
            inner.id
            for inner in definition.loops
            if inside(inner, outer) and not inside(outer, inner)
        ]
        for outer in definition.loops
    }


def make_loop_failed_node(loop_id: str) -> NodeCallable:
    async def node_fn(state: PipelineState) -> dict[str, dict[str, NodeResult]]:
        raise PipelineExecutionError(
            f"loop '{loop_id}' exceeded max_iterations without meeting exit_when "
            f"(on_max_iterations=fail)",
            loop_id=loop_id,
        )

    return node_fn


def wire_loop(graph: StateGraph, loop: LoopConfig, nested: list[str]) -> None:
    """`nested`: the loops inside this one (see nested_loops)."""
    inc_id = f"__loop_inc_{loop.id}__"
    failed_id = f"__loop_failed_{loop.id}__"

    graph.add_node(inc_id, _make_loop_increment_node(loop.id, nested))
    graph.add_node(failed_id, make_loop_failed_node(loop.id))
    graph.add_edge(inc_id, loop.back_to)

    exit_target = END if loop.exit_to == "END" else loop.exit_to
    path_map: dict[Hashable, str] = {"loop": inc_id, "exit": exit_target, "fail": failed_id}
    graph.add_conditional_edges(loop.from_, _make_loop_router(loop), path_map)
