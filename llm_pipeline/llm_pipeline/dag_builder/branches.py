from collections.abc import Hashable
from langgraph.graph import StateGraph

from llm_pipeline.pipeline_config import BranchConfig, BranchRoute
from llm_pipeline.safe_eval import evaluate_condition
from llm_pipeline.dag_builder.node_types import RouterCallable
from llm_pipeline.state import PipelineState


def _make_branch_router(
    branch: BranchConfig, keyed_routes: list[tuple[str, BranchRoute]]
) -> RouterCallable:
    def router(state: PipelineState) -> str:
        output = state["node_outputs"][branch.from_]["output"]
        default_key: str | None = None
        for key, route in keyed_routes:
            if route.default:
                default_key = key
                continue
            assert route.when is not None
            if evaluate_condition(route.when, output):
                return key
        assert default_key is not None  # guaranteed: exactly one default route (validated at load)
        return default_key

    return router


def wire_branch(graph: StateGraph, branch: BranchConfig) -> None:
    keyed_routes = [(f"__branch_{branch.id}_{i}__", route) for i, route in enumerate(branch.routes)]
    path_map: dict[Hashable, str] = {key: route.to for key, route in keyed_routes}
    graph.add_conditional_edges(branch.from_, _make_branch_router(branch, keyed_routes), path_map)
