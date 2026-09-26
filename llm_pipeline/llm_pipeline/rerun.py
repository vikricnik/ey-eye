"""
Re-running a pipeline from one node: that node and everything after it run
again, and every other node's output is reused from the previous run — so a
prompt can be tuned without paying for the steps before it.

"After" follows the graph's forward edges: dependencies, branch routes and a
loop's exit. A reused node replays its previous output only on its FIRST
execution in the run; if a loop sends the run back to it, it runs for real
(re-running `critique` in a generate → critique loop reuses the draft, and
if the new critique asks for a revision, `generate` genuinely revises).

A reused branch source replays the same output, so it takes the same route
as before — the node being re-run is reached again.
"""

from llm_pipeline.pipeline_config import PipelineDefinition


def downstream(definition: PipelineDefinition, node_id: str) -> set[str]:
    """`node_id` and every node that runs after it."""
    following: dict[str, set[str]] = {n.id: set() for n in definition.nodes}
    for node in definition.nodes:
        for dependency in node.depends_on:
            following[dependency].add(node.id)
    for branch in definition.branches:
        following[branch.from_].update(t for route in branch.routes for t in route.targets)
    for loop in definition.loops:
        if loop.exit_to in following:
            following[loop.from_].add(loop.exit_to)

    reached = {node_id}
    pending = [node_id]
    while pending:
        for later in following.get(pending.pop(), set()):
            if later not in reached:
                reached.add(later)
                pending.append(later)
    return reached


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
