from collections.abc import Hashable

from langgraph.graph import StateGraph

from llm_pipeline.dag_builder.node_types import RouterCallable
from llm_pipeline.pipeline_config import BranchConfig
from llm_pipeline.safe_eval import evaluate_condition
from llm_pipeline.state import PipelineState


def _route_keys(branch: BranchConfig, route_index: int) -> list[Hashable]:
    """One path-map key per target of the route — a route with several
    targets sends the run to all of them at once."""
    route = branch.routes[route_index]
    return [f"__branch_{branch.id}_{route_index}_{t}__" for t in range(len(route.targets))]


def _make_branch_router(branch: BranchConfig) -> RouterCallable:
    default_index = next(i for i, r in enumerate(branch.routes) if r.default)

    def router(state: PipelineState) -> list[Hashable]:
        output = state["node_outputs"][branch.from_]["output"]
        for index, route in enumerate(branch.routes):
            if route.when is not None and evaluate_condition(route.when, output, state["input"]):
                return _route_keys(branch, index)
        return _route_keys(branch, default_index)

    return router


def wire_branch(graph: StateGraph, branch: BranchConfig) -> None:
    path_map: dict[Hashable, str] = {
        key: target
        for index, route in enumerate(branch.routes)
        for key, target in zip(_route_keys(branch, index), route.targets, strict=True)
    }
    graph.add_conditional_edges(branch.from_, _make_branch_router(branch), path_map)
