"""
Re-running a pipeline from one node: that node and everything after it run
again, and every other node's output is reused from the previous run — so a
prompt can be tuned without paying for the steps before it.

"After" follows the graph's forward edges (see pipeline_config/topology.py):
dependencies, branch routes, a loop's exit, and a loop's back_to when it
points forward (declares the loop source in depends_on). A reused node
replays its previous output only on its FIRST execution in the run; if a
loop sends the run back to it, it runs for real
(re-running `critique` in a generate → critique loop reuses the draft, and
if the new critique asks for a revision, `generate` genuinely revises).

A reused branch source replays the same output, so it takes the same route
as before — the node being re-run is reached again.
"""

from llm_pipeline.pipeline_config import PipelineDefinition, Topology


def downstream(definition: PipelineDefinition, node_id: str) -> set[str]:
    """`node_id` and every node that runs after it."""
    return set(Topology(definition).reachable_from(node_id))


def replay_outputs(
    definition: PipelineDefinition, from_node: str, outputs: dict[str, str]
) -> dict[str, str]:
    """The outputs to reuse: those of nodes that still exist and don't run
    after `from_node`. A node with no previous output simply runs."""
    rerun = downstream(definition, from_node)
    existing = {n.id for n in definition.nodes}
    return {
        node_id: text
        for node_id, text in outputs.items()
        if node_id in existing and node_id not in rerun
    }
