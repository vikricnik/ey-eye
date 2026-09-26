"""
Turns a validated PipelineDefinition into a compiled, runnable LangGraph.

Base DAG mapping:
  - each NodeConfig becomes one graph node, built via build_node() (see
    node_types.py's registry — dispatches on node_cfg.type)
  - each depends_on entry becomes one graph edge
  - two nodes with no edge between them run in parallel, automatically
  - a node with multiple depends_on doesn't run until ALL of them complete —
    one multi-source edge (a LangGraph barrier), since separate edges would
    start it as soon as ANY of them finished. Exception: when its inputs
    don't always run together (behind different branch routes, or only some
    re-run by a loop), waiting for all could wait forever, so that node
    keeps one edge per dependency and runs after whichever arrive — see
    pipeline_config/activation.py.

`branches` and `loops` both compile to LangGraph conditional edges
(`add_conditional_edges`), which is a genuinely different mechanism from
the base DAG wiring above:

  - A branch/loop's `from_` node has its ENTIRE outgoing routing handled by
    one conditional dispatch. No plain depends_on-based edge may also
    originate from it (LangGraph doesn't support mixing a plain edge and a
    conditional edge from the same source) — pipeline_config/validation.py
    validates this at load time.
  - Because of that, the base depends_on wiring loop below explicitly skips
    any edge whose SOURCE is a branch/loop source; those edges are instead
    added by wire_branch/wire_loop (branches.py / loops.py).
  - The automatic "wire output_node to END" step is likewise conditional:
    it only fires for output_node candidates that don't already have some
    other way of reaching forward (a normal edge, or being a conditional
    source) — a loop's `back_to` target has a normal forward edge already
    and reaches END via the loop's own `exit_to`, not through here.
"""

from langgraph.graph import END, StateGraph
from langgraph.graph.state import CompiledStateGraph

from llm_pipeline.dag_builder.branches import wire_branch
from llm_pipeline.dag_builder.loops import nested_loops, wire_loop
from llm_pipeline.dag_builder.node_types import ContextProbe, build_node
from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.pipeline_config.activation import joins_that_wait_for_all
from llm_pipeline.providers.resilience import CircuitBreaker
from llm_pipeline.state import NodeResult, PipelineState


def build_graph(
    definition: PipelineDefinition,
    circuit_breaker: CircuitBreaker | None = None,
    context_probe: ContextProbe | None = None,
) -> CompiledStateGraph:
    """`circuit_breaker` is optional dependency injection: pass an
    explicitly-owned instance (e.g. one held by a PipelineCache) to scope
    circuit-breaker state to that cache rather than sharing the process-wide
    default in providers/resilience.py. Every llm_call node built for this
    graph receives the same instance, threaded down through build_node() —
    and likewise `context_probe`, which lets a node report how much context
    its Ollama model had (see node_types.ContextProbe)."""
    graph: StateGraph = StateGraph(PipelineState)

    for node_cfg in definition.nodes:
        graph.add_node(
            node_cfg.id, build_node(node_cfg, definition, circuit_breaker, context_probe)
        )

    conditional_sources = definition.conditional_sources
    waits_for_all = joins_that_wait_for_all(definition)

    # Base wiring from depends_on, EXCEPT where the source is a branch/loop's
    # from_ node — that source's entire outgoing routing is added via
    # wire_branch/wire_loop below instead.
    for node_cfg in definition.nodes:
        deps = [d for d in node_cfg.depends_on if d not in conditional_sources]
        if node_cfg.id in waits_for_all:
            graph.add_edge(deps, node_cfg.id)  # waits for all of them
            continue
        for dep_id in deps:
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
        wire_branch(graph, branch)

    nested = nested_loops(definition)
    for loop in definition.loops:
        wire_loop(graph, loop, nested[loop.id])

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
