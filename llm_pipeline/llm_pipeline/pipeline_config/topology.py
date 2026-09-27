"""
Who runs after whom in a pipeline definition.

Three kinds of edge lead from one node to the next: a depends_on entry, a
branch route, and a loop's exit. A loop's way back is "after" only when its
back_to declares the loop source in depends_on (a back_to that points
forward); otherwise it returns to an earlier node. This module is the one
place that enumerates these edges — the graph builder, activation.py
(which joins can wait for all inputs), rerun.py (what a re-run repeats)
and validation.py (which depends_on entries are really a branch's or a
loop's) all ask it instead of re-deriving them.
packages/client/src/topology.ts mirrors the subset the editor needs; both
are pinned by contracts/topology-cases.json.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Type hint only — validation.py builds a Topology while a
    # PipelineDefinition is being validated, so a runtime import is circular.
    from llm_pipeline.pipeline_config.schema import PipelineDefinition


@dataclass(frozen=True, kw_only=True)
class IncomingRoute:
    """A branch route that starts a node."""

    source_node_id: str  # the branch's `from` node
    branch_id: str
    route_index: int


class Topology:
    """An immutable snapshot of one definition's shape — cheap to build, so
    callers build one per question or share one per pass. Every query about
    a node or loop raises KeyError for an id the definition doesn't have."""

    def __init__(self, definition: "PipelineDefinition") -> None:
        self.node_ids: tuple[str, ...] = tuple(n.id for n in definition.nodes)
        known = set(self.node_ids)
        self._loops = {loop.id: loop for loop in definition.loops}
        self.loop_ids: tuple[str, ...] = tuple(self._loops)

        # Nodes whose outgoing edges belong entirely to a branch or loop.
        self.conditional_sources: frozenset[str] = frozenset(
            [b.from_ for b in definition.branches] + [loop.from_ for loop in definition.loops]
        )
        # Nodes some branch route starts.
        self.branch_targets: frozenset[str] = frozenset(
            t for b in definition.branches for route in b.routes for t in route.targets
        )
        # Nodes that start as soon as the run does: no dependencies, and
        # not waiting for a branch to route to them.
        self.effective_roots: tuple[str, ...] = tuple(
            n.id for n in definition.nodes if not n.depends_on and n.id not in self.branch_targets
        )
        self.loop_exit_targets: frozenset[str] = frozenset(
            loop.exit_node for loop in definition.loops if loop.exit_node in known
        )

        self._plain: dict[str, tuple[str, ...]] = {
            n.id: tuple(d for d in n.depends_on if d not in self.conditional_sources)
            for n in definition.nodes
        }
        depends_on = {n.id: set(n.depends_on) for n in definition.nodes}

        self._routes_into: dict[str, list[IncomingRoute]] = {}
        self._route_targets: dict[str, set[str]] = {}
        # source -> nodes it leads to right away, other than through a loop exit
        self._next: dict[str, set[str]] = {}
        for node_id, deps in self._plain.items():
            for dep in deps:
                self._next.setdefault(dep, set()).add(node_id)
        for branch in definition.branches:
            for index, route in enumerate(branch.routes):
                for target in route.targets:
                    self._routes_into.setdefault(target, []).append(
                        IncomingRoute(
                            source_node_id=branch.from_, branch_id=branch.id, route_index=index
                        )
                    )
                    self._route_targets.setdefault(branch.from_, set()).add(target)
                    self._next.setdefault(branch.from_, set()).add(target)
        for loop in definition.loops:
            if loop.from_ in depends_on.get(loop.back_to, set()):
                self._next.setdefault(loop.from_, set()).add(loop.back_to)  # forward back_to

        # source node -> (loop id, exit node) for loops exiting to a node
        self._exits: dict[str, list[tuple[str, str]]] = {}
        for loop in definition.loops:
            if loop.exit_node in known:
                self._exits.setdefault(loop.from_, []).append((loop.id, loop.exit_node))

    def _node(self, node_id: str) -> str:
        if node_id not in self._plain:
            raise KeyError(node_id)
        return node_id

    def plain_dependencies(self, node_id: str) -> tuple[str, ...]:
        """depends_on without the entries that are really a branch's or a
        loop's edge (those come from routes_into / the loop instead)."""
        return self._plain[self._node(node_id)]

    def routes_into(self, node_id: str) -> tuple[IncomingRoute, ...]:
        return tuple(self._routes_into.get(self._node(node_id), []))

    def has_outgoing_edges(self, node_id: str) -> bool:
        """Whether the built graph gives the node an outgoing edge: a plain
        dependent, or its branch or loop dispatch — even when every place
        that dispatch leads is earlier or the end of the run. So this is NOT
        `bool(successors(node_id))`: the graph builder asks it to decide
        whether an output node still needs its own edge to END."""
        node_id = self._node(node_id)
        return node_id in self.conditional_sources or any(
            node_id in deps for deps in self._plain.values()
        )

    def declared_destinations(self, source: str) -> frozenset[str]:
        """Where a branch or loop source may send the run — its route
        targets, or its loop's back_to and exit node. Excludes plain
        dependents; empty for a node that is neither."""
        source = self._node(source)
        found = set(self._route_targets.get(source, set()))
        for loop in self._loops.values():
            if loop.from_ == source:
                found.add(loop.back_to)
        found.update(exit_node for _, exit_node in self._exits.get(source, []))
        return frozenset(found)

    def successors(self, node_id: str) -> frozenset[str]:
        """Nodes that run right after `node_id`: its dependents, its route
        targets, a forward back_to, and where its loops exit to."""
        return self._successors(self._node(node_id), skip_exit_of_loop=None)

    def reachable_from(self, node_id: str) -> frozenset[str]:
        """`node_id` and every node that runs after it."""
        return self._reachable_from(self._node(node_id), skip_exit_of_loop=None)

    def loop_scope(self, loop_id: str) -> frozenset[str]:
        """The nodes a loop runs again on each pass: everything after its
        back_to, through inner loops' exits, up to its own exit."""
        return self._reachable_from(self._loops[loop_id].back_to, skip_exit_of_loop=loop_id)

    def inner_loops(self, loop_id: str) -> tuple[str, ...]:
        """The loops entirely inside `loop_id` — their back_to and from both
        run again on each of its passes. Two loops that would each count as
        inside the other (possible only through odd branch cycles) are left
        alone: resetting each other, neither would ever end."""
        scope = self.loop_scope(loop_id)
        return tuple(
            inner
            for inner, loop in self._loops.items()
            if inner != loop_id
            and {loop.back_to, loop.from_} <= scope
            and not {self._loops[loop_id].back_to, self._loops[loop_id].from_}
            <= self.loop_scope(inner)
        )

    def _successors(self, node_id: str, *, skip_exit_of_loop: str | None) -> frozenset[str]:
        after = set(self._next.get(node_id, set()))
        after.update(
            exit_node
            for loop_id, exit_node in self._exits.get(node_id, [])
            if loop_id != skip_exit_of_loop
        )
        return frozenset(after)

    def _reachable_from(self, node_id: str, *, skip_exit_of_loop: str | None) -> frozenset[str]:
        reached, pending = set[str](), [node_id]
        while pending:
            current = pending.pop()
            if current not in reached:
                reached.add(current)
                pending.extend(self._successors(current, skip_exit_of_loop=skip_exit_of_loop))
        return frozenset(reached)
