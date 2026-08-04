from collections.abc import Hashable

from langgraph.graph import END, StateGraph

from llm_pipeline.dag_builder.node_types import (
    LoopIncrementCallable,
    NodeCallable,
    RouterCallable,
)
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.pipeline_config import LoopConfig
from llm_pipeline.safe_eval import evaluate_condition
from llm_pipeline.state import NodeResult, PipelineState


def _make_loop_router(loop: LoopConfig) -> RouterCallable:
    def router(state: PipelineState) -> str:
        counts = state.get("loop_counts", {})
        count = counts.get(loop.id, 0)

        if count >= loop.max_iterations:
            return "fail" if loop.on_max_iterations == "fail" else "exit"

        output = state["node_outputs"][loop.from_]["output"]
        if evaluate_condition(loop.exit_when, output):
            return "exit"
        return "loop"

    return router


def _make_loop_increment_node(loop_id: str) -> LoopIncrementCallable:
    async def node_fn(state: PipelineState) -> dict[str, dict[str, int]]:
        counts = dict(state.get("loop_counts", {}))
        counts[loop_id] = counts.get(loop_id, 0) + 1
        return {"loop_counts": counts}

    return node_fn


def _make_loop_failed_node(loop_id: str) -> NodeCallable:
    async def node_fn(state: PipelineState) -> dict[str, dict[str, NodeResult]]:
        raise PipelineExecutionError(
            f"loop '{loop_id}' exceeded max_iterations without meeting exit_when "
            f"(on_max_iterations=fail)"
        )

    return node_fn


def wire_loop(graph: StateGraph, loop: LoopConfig) -> None:
    inc_id = f"__loop_inc_{loop.id}__"
    failed_id = f"__loop_failed_{loop.id}__"

    graph.add_node(inc_id, _make_loop_increment_node(loop.id))
    graph.add_node(failed_id, _make_loop_failed_node(loop.id))
    graph.add_edge(inc_id, loop.back_to)

    exit_target = END if loop.exit_to == "END" else loop.exit_to
    path_map: dict[Hashable, str] = {"loop": inc_id, "exit": exit_target, "fail": failed_id}
    graph.add_conditional_edges(loop.from_, _make_loop_router(loop), path_map)
