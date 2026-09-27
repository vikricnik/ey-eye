"""
Which joins can wait for all of their inputs.

A join — a node with several depends_on — should run once, after all its
inputs. LangGraph expresses that as one edge from all of them (a barrier),
but a barrier then waits until EVERY input has run: forever, if one of them
never runs on this request (it sits after a branch route that wasn't taken)
or doesn't run again (a loop re-runs some inputs of a join but not others).

So each node gets an activation guard: the decisions that make it run —
the branch routes that lead to it and the loops that re-run it. Inputs with
the same guard always run together, so a join over them can safely wait
for all of them. Anything else (inputs behind different routes, a mix of
looped and run-once inputs, nodes reached several ways) keeps one edge per
input and runs after whichever arrive.
"""

from llm_pipeline.pipeline_config.topology import Topology

# A guard is a set of tokens: ("route", branch id, route index),
# ("loop", loop id), or ("unknown", node id) when a node is reached in a
# way this analysis doesn't model — which never compares equal to anything
# but itself, so joins over such nodes stay unguarded.
Guard = frozenset[tuple[str, ...]]
_ALWAYS: Guard = frozenset()


def joins_that_wait_for_all(topology: Topology) -> frozenset[str]:
    """Nodes whose depends_on can be wired as one wait-for-all edge."""
    return frozenset(_Activation(topology).joins)


def inputs_that_may_never_arrive(topology: Topology) -> dict[str, set[str]]:
    """node id -> those of its inputs that, on some requests where it runs,
    never run at all: an input behind a branch route that another of its
    inputs doesn't need (e.g. a join after two different routes — only one
    of them is ever taken). Only joins that run after whichever input
    arrives can have any."""
    activation = _Activation(topology)
    found: dict[str, set[str]] = {}
    for node_id in topology.node_ids:
        deps = topology.plain_dependencies(node_id)
        if len(deps) < 2 or node_id in activation.joins:
            continue
        routes = {d: {t for t in activation.guards[d] if t[0] == "route"} for d in deps}
        missing = {d for d in deps if any(not routes[d] <= routes[e] for e in deps if e != d)}
        if missing:
            found[node_id] = missing
    return found


class _Activation:
    def __init__(self, topology: Topology) -> None:
        self.topology = topology
        self.roots = set(topology.effective_roots)

        # node id -> the loops that run it again on each of their passes
        self.rerun_by: dict[str, set[str]] = {}
        for loop_id in topology.loop_ids:
            for node_id in topology.loop_scope(loop_id):
                self.rerun_by.setdefault(node_id, set()).add(loop_id)

        self.guards: dict[str, Guard] = {}
        self.joins: set[str] = set()
        self._visiting: set[str] = set()
        for node_id in topology.node_ids:
            self.guard(node_id)

    def guard(self, node_id: str) -> Guard:
        if node_id in self.guards:
            return self.guards[node_id]
        unknown: Guard = frozenset({("unknown", node_id)})
        if node_id in self._visiting:  # a cycle through branch routes
            return unknown
        self._visiting.add(node_id)

        plain = self.topology.plain_dependencies(node_id)
        sources = [self.guard(dep) for dep in plain]
        if node_id in self.roots:
            sources.append(_ALWAYS)
        for route in self.topology.routes_into(node_id):
            token = ("route", route.branch_id, str(route.route_index))
            sources.append(self.guard(route.source_node_id) | {token})
        if node_id in self.topology.loop_exit_targets:
            sources.append(unknown)

        only_plain = len(sources) == len(plain)
        if len(plain) > 1 and only_plain and len(set(sources)) == 1 and _certain(sources[0]):
            self.joins.add(node_id)
            guard = sources[0]
        elif len(sources) == 1:
            guard = sources[0]
        else:
            guard = unknown
        guard |= {("loop", loop_id) for loop_id in self.rerun_by.get(node_id, set())}

        self._visiting.discard(node_id)
        self.guards[node_id] = guard
        return guard


def _certain(guard: Guard) -> bool:
    return not any(token[0] == "unknown" for token in guard)
