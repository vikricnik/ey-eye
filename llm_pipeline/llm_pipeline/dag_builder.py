"""
Turns a validated PipelineDefinition into a compiled, runnable LangGraph.

Base DAG mapping (unchanged from phase 1):
  - each NodeConfig becomes one graph node
  - each depends_on entry becomes one graph edge
  - two nodes with no edge between them run in parallel, automatically
  - a node with multiple depends_on doesn't run until ALL of them complete

Phase 2 additions — `branches` and `loops` — both compile to LangGraph
conditional edges (`add_conditional_edges`), which is a genuinely different
mechanism from the base DAG wiring above:

  - A branch/loop's `from_` node has its ENTIRE outgoing routing handled by
    one conditional dispatch. No plain depends_on-based edge may also
    originate from it (LangGraph doesn't support mixing a plain edge and a
    conditional edge from the same source) — pipeline_config.py validates
    this at load time.
  - Because of that, the base depends_on wiring loop below explicitly skips
    any edge whose SOURCE is a branch/loop source; those edges are instead
    added by the branch/loop wiring sections further down.
  - The automatic "wire output_node to END" step is likewise conditional:
    it only fires for output_node candidates that don't already have some
    other way of reaching forward (a normal edge, or being a conditional
    source) — a loop's `back_to` target has a normal forward edge already
    and reaches END via the loop's own `exit_to`, not through here.
"""

import logging
import time
from collections.abc import Awaitable, Callable, Hashable

from langgraph.graph import StateGraph, END
from langgraph.graph.state import CompiledStateGraph

from llm_pipeline.pipeline_config import (
    PipelineDefinition,
    NodeConfig,
    BranchConfig,
    BranchRoute,
    LoopConfig,
)
from llm_pipeline.providers import ModelSpec, get_provider, generate_with_retry, ProviderError
from llm_pipeline.safe_eval import evaluate_condition
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.models import PipelineState, NodeResult

logger: logging.Logger = logging.getLogger("llm_pipeline")

# Every LangGraph node callable used in this module fits one of these two
# shapes: an async function producing a partial node_outputs update, or a
# synchronous routing function returning a plain string key. Named here so
# the factory functions below have precise, reusable return types instead of
# each repeating (or worse, omitting) the same Callable[...] signature.
NodeCallable = Callable[[PipelineState], Awaitable[dict[str, dict[str, NodeResult]]]]
RouterCallable = Callable[[PipelineState], str]
LoopIncrementCallable = Callable[[PipelineState], Awaitable[dict[str, dict[str, int]]]]


# ---------------------------------------------------------------------------
# Template rendering (Jinja2 — supports {% if x is defined %} guards, which
# plain string substitution can't express and loops genuinely need: a loop's
# back_to target references its own loop's `from_` node's output, which
# hasn't run yet on the very first iteration)
# ---------------------------------------------------------------------------

class _NodeOutputView:
    """Exposes a completed node's result as `{{ node_id.output }}` in Jinja."""

    __slots__ = ("output",)

    def __init__(self, output: str) -> None:
        self.output = output


def render_template(template_str: str, node_outputs: dict[str, NodeResult], input_text: str) -> str:
    from jinja2 import Environment  # local import: keep module import time light

    env = Environment()
    template = env.from_string(template_str)
    context: dict[str, object] = {"input": input_text}
    for node_id, result in node_outputs.items():
        context[node_id] = _NodeOutputView(result["output"])
    # str(...) here isn't redundant: template.render() resolves to `Any`
    # (its exact type depends on jinja2's own stub availability), and
    # returning that directly would leak Any past this function's declared
    # `-> str` return type (mypy's warn_return_any/no-any-return catches
    # exactly this) — str() gives mypy a concrete, guaranteed-str value.
    return str(template.render(**context))


# ---------------------------------------------------------------------------
# llm_call node factory (unchanged mechanics from phase 1, now Jinja-rendered)
# ---------------------------------------------------------------------------

def _make_llm_call_node(
    node_cfg: NodeConfig,
    timeout_seconds: float,
    max_retries: int,
    retry_backoff_seconds: float,
) -> NodeCallable:
    if node_cfg.type != "llm_call":
        raise ValueError(f"Unsupported node type: {node_cfg.type}")

    assert node_cfg.model is not None  # enforced by NodeConfig's validator
    spec = ModelSpec(node_cfg.model.provider, node_cfg.model.model, node_cfg.model.temperature)

    async def node_fn(state: PipelineState) -> dict[str, dict[str, NodeResult]]:
        provider = get_provider(spec)
        prompt = render_template(
            node_cfg.prompt_template, state["node_outputs"], state["contextual_input"]
        )

        started_at = time.monotonic()
        try:
            answer = await generate_with_retry(
                provider,
                prompt,
                spec,
                timeout_seconds,
                max_attempts=max_retries + 1,
                backoff_base_seconds=retry_backoff_seconds,
            )
        except ProviderError as e:
            logger.warning(f"[node:{node_cfg.id}] {spec.identity} failed: {e}")
            raise PipelineExecutionError(f"Node '{node_cfg.id}' failed: {e}") from e

        duration_ms = (time.monotonic() - started_at) * 1000

        result: NodeResult = {
            "node_id": node_cfg.id,
            "model_name": spec.identity,
            "output": answer,
            "duration_ms": duration_ms,
        }
        logger.info(f"[node:{node_cfg.id}] model={spec.identity} duration_ms={duration_ms:.0f}")
        return {"node_outputs": {node_cfg.id: result}}

    return node_fn


# ---------------------------------------------------------------------------
# Branch wiring
# ---------------------------------------------------------------------------

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


def _wire_branch(graph: StateGraph, branch: BranchConfig) -> None:
    keyed_routes = [(f"__branch_{branch.id}_{i}__", route) for i, route in enumerate(branch.routes)]
    path_map: dict[Hashable, str] = {key: route.to for key, route in keyed_routes}
    graph.add_conditional_edges(branch.from_, _make_branch_router(branch, keyed_routes), path_map)


# ---------------------------------------------------------------------------
# Loop wiring
# ---------------------------------------------------------------------------

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


def _wire_loop(graph: StateGraph, loop: LoopConfig) -> None:
    inc_id = f"__loop_inc_{loop.id}__"
    failed_id = f"__loop_failed_{loop.id}__"

    graph.add_node(inc_id, _make_loop_increment_node(loop.id))
    graph.add_node(failed_id, _make_loop_failed_node(loop.id))
    graph.add_edge(inc_id, loop.back_to)

    exit_target = END if loop.exit_to == "END" else loop.exit_to
    path_map: dict[Hashable, str] = {"loop": inc_id, "exit": exit_target, "fail": failed_id}
    graph.add_conditional_edges(loop.from_, _make_loop_router(loop), path_map)


# ---------------------------------------------------------------------------
# Graph assembly
# ---------------------------------------------------------------------------

def build_graph(definition: PipelineDefinition) -> CompiledStateGraph:
    graph: StateGraph = StateGraph(PipelineState)

    for node_cfg in definition.nodes:
        graph.add_node(
            node_cfg.id,
            _make_llm_call_node(
                node_cfg,
                definition.execution.model_timeout_seconds,
                definition.execution.max_retries,
                definition.execution.retry_backoff_seconds,
            ),
        )

    conditional_sources = definition.conditional_sources

    # Base wiring: one edge per depends_on entry, EXCEPT where the source is
    # a branch/loop's from_ node — that source's entire outgoing routing is
    # added via _wire_branch/_wire_loop below instead.
    for node_cfg in definition.nodes:
        for dep_id in node_cfg.depends_on:
            if dep_id in conditional_sources:
                continue
            graph.add_edge(dep_id, node_cfg.id)

    root_ids = definition.effective_root_ids
    if len(root_ids) == 1:
        graph.set_entry_point(root_ids[0])
    else:
        # Multiple independent roots: LangGraph wants one entry point, so
        # fan out from a trivial no-op node. NOTE: must not be named
        # "__start__" — that's LangGraph's own reserved sentinel name.
        async def _fan_out_node(state: PipelineState) -> dict[str, dict[str, NodeResult]]:
            return {}

        graph.add_node("__dag_root__", _fan_out_node)
        graph.set_entry_point("__dag_root__")
        for root_id in root_ids:
            graph.add_edge("__dag_root__", root_id)

    for branch in definition.branches:
        _wire_branch(graph, branch)

    for loop in definition.loops:
        _wire_loop(graph, loop)

    # output_node(s) -> END, only for candidates with no other outgoing edge
    # already defined (plain or conditional) — see module docstring for why
    # this can't be unconditional once loops/branches exist.
    nodes_with_outgoing_edges = {
        dep for n in definition.nodes for dep in n.depends_on
    } | conditional_sources
    for candidate in definition.output_node_candidates:
        if candidate not in nodes_with_outgoing_edges:
            graph.add_edge(candidate, END)

    return graph.compile()
