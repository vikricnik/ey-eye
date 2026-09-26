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

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Type hint only — validation.py calls this while a PipelineDefinition
    # is being built, so a runtime import would be circular.
    from llm_pipeline.pipeline_config.schema import PipelineDefinition

# A guard is a set of tokens: ("route", branch id, route index),
# ("loop", loop id), or ("unknown", node id) when a node is reached in a
# way this analysis doesn't model — which never compares equal to anything
# but itself, so joins over such nodes stay unguarded.
Guard = frozenset[tuple[str, ...]]
_ALWAYS: Guard = frozenset()


def joins_that_wait_for_all(definition: "PipelineDefinition") -> set[str]:
    """Nodes whose depends_on can be wired as one wait-for-all edge."""
    return _Activation(definition).joins


def inputs_that_may_never_arrive(definition: "PipelineDefinition") -> dict[str, set[str]]:
    """node id -> those of its inputs that, on some requests where it runs,
    never run at all: an input behind a branch route that another of its
    inputs doesn't need (e.g. a join after two different routes — only one
    of them is ever taken). Only joins that run after whichever input
    arrives can have any."""
    activation = _Activation(definition)
    found: dict[str, set[str]] = {}
    for node_id in activation.nodes:
        deps = activation.plain_deps(node_id)
        if len(deps) < 2 or node_id in activation.joins:
            continue
        routes = {d: {t for t in activation.guards[d] if t[0] == "route"} for d in deps}
        missing = {d for d in deps if any(not routes[d] <= routes[e] for e in deps if e != d)}
        if missing:
            found[node_id] = missing
    return found


class _Activation:
    def __init__(self, definition: "PipelineDefinition") -> None:
        self.nodes = {n.id: n for n in definition.nodes}
        self.conditional_sources = definition.conditional_sources
        self.roots = set(definition.effective_root_ids)
        self.exit_targets = {loop.exit_to for loop in definition.loops}

        self.routes_into: dict[str, list[tuple[str, tuple[str, ...]]]] = {}
        for branch in definition.branches:
            for index, route in enumerate(branch.routes):
                for target in route.targets:
                    token = ("route", branch.id, str(index))
                    self.routes_into.setdefault(target, []).append((branch.from_, token))

        self.rerun_by = self._loop_scopes(definition)
        self.guards: dict[str, Guard] = {}
        self.joins: set[str] = set()
        self._visiting: set[str] = set()
        for node_id in self.nodes:
            self.guard(node_id)

    def plain_deps(self, node_id: str) -> list[str]:
        return [d for d in self.nodes[node_id].depends_on if d not in self.conditional_sources]

    def _loop_scopes(self, definition: "PipelineDefinition") -> dict[str, set[str]]:
        """node id -> the loops that re-run it: everything forward of a
        loop's back_to runs again on each pass."""
        forward: dict[str, list[str]] = {}
        for node_id in self.nodes:
            for dep in self.plain_deps(node_id):
                forward.setdefault(dep, []).append(node_id)
        for target, sources in self.routes_into.items():
            for source, _ in sources:
                forward.setdefault(source, []).append(target)

        rerun_by: dict[str, set[str]] = {}
        for loop in definition.loops:
            pending, seen = [loop.back_to], set[str]()
            while pending:
                node_id = pending.pop()
                if node_id not in seen:
                    seen.add(node_id)
                    rerun_by.setdefault(node_id, set()).add(loop.id)
                    pending.extend(forward.get(node_id, []))
        return rerun_by

    def guard(self, node_id: str) -> Guard:
        if node_id in self.guards:
            return self.guards[node_id]
        unknown: Guard = frozenset({("unknown", node_id)})
        if node_id in self._visiting:  # a cycle through branch routes
            return unknown
        self._visiting.add(node_id)

        plain = self.plain_deps(node_id)
        sources = [self.guard(dep) for dep in plain]
        if node_id in self.roots:
            sources.append(_ALWAYS)
        for source, token in self.routes_into.get(node_id, []):
            sources.append(self.guard(source) | {token})
        if node_id in self.exit_targets:
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
