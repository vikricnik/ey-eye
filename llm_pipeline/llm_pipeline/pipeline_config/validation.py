"""
Whole-DAG validation for a parsed PipelineDefinition.

Deliberately standalone functions (not methods on PipelineDefinition)
taking a definition as a plain argument — this means they can be tested,
reused, or called (e.g. from a future `pipelines validate` CLI command)
without going through Pydantic's model-construction lifecycle at all. The
single entry point, validate_pipeline_dag(), is what schema.py's
PipelineDefinition.validate_dag model_validator calls into.

`PipelineDefinition` is imported only under TYPE_CHECKING — these functions
only ever access it via attribute access on the `definition` parameter
(never construct or isinstance-check it directly), so no runtime import is
needed, which is what avoids a circular import with schema.py (which calls
into this module from inside a method).
"""

from typing import TYPE_CHECKING

from jinja2 import Environment, meta

if TYPE_CHECKING:
    from llm_pipeline.pipeline_config.schema import PipelineDefinition

_template_parse_env = Environment()

# The literal sentinel meaning "route straight to the end of the graph"
# rather than to another named node.
END_SENTINEL = "END"


def validate_pipeline_dag(definition: "PipelineDefinition") -> None:
    """The single entry point — raises ValueError (wrapped into a pydantic
    ValidationError by the caller in schema.py) on the first problem found."""
    ids = [n.id for n in definition.nodes]

    if len(ids) != len(set(ids)):
        duplicates = {i for i in ids if ids.count(i) > 1}
        raise ValueError(f"duplicate node id(s): {', '.join(sorted(duplicates))}")

    id_set = set(ids)

    for node in definition.nodes:
        for dep in node.depends_on:
            if dep not in id_set:
                raise ValueError(f"node '{node.id}' depends_on unknown node '{dep}'")
            if dep == node.id:
                raise ValueError(f"node '{node.id}' cannot depend on itself")

    for candidate in definition.output_node_candidates:
        if candidate not in id_set:
            raise ValueError(f"output_node '{candidate}' is not a defined node id")

    _check_for_cycles(definition, ids)
    _validate_branches(definition, id_set)
    _validate_loops(definition, id_set)
    _check_no_conflicting_conditional_edges(definition, id_set)
    _check_template_references(definition, id_set)

    if not definition.effective_root_ids:
        raise ValueError(
            "pipeline has no entry point — every node with no dependencies "
            "is exclusively a branch route target"
        )


def _check_for_cycles(definition: "PipelineDefinition", ids: list[str]) -> None:
    """Cycle check over `depends_on` ONLY — loops are a deliberately
    separate mechanism and are allowed, indeed expected, to introduce real
    cycles in the compiled graph. Allowing that here would defeat the point
    of keeping depends_on a validated DAG that's easy to reason about
    independent of control flow."""
    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {node_id: WHITE for node_id in ids}
    deps: dict[str, list[str]] = {n.id: n.depends_on for n in definition.nodes}

    def visit(node_id: str, path: list[str]) -> None:
        color[node_id] = GRAY
        for dep in deps[node_id]:
            if color[dep] == GRAY:
                cycle = " -> ".join(path + [node_id, dep])
                raise ValueError(f"cycle detected in depends_on: {cycle}")
            if color[dep] == WHITE:
                visit(dep, path + [node_id])
        color[node_id] = BLACK

    for node_id in ids:
        if color[node_id] == WHITE:
            visit(node_id, [])


def _validate_branches(definition: "PipelineDefinition", id_set: set[str]) -> None:
    seen_from: set[str] = set()
    for branch in definition.branches:
        if branch.from_ not in id_set:
            raise ValueError(f"branch '{branch.id}' from unknown node '{branch.from_}'")
        if branch.from_ in seen_from:
            raise ValueError(
                f"node '{branch.from_}' is the source of more than one branch/loop — "
                f"a node's outgoing routing can only be governed by one construct"
            )
        seen_from.add(branch.from_)

        for route in branch.routes:
            if route.to not in id_set:
                raise ValueError(f"branch '{branch.id}' routes to unknown node '{route.to}'")


def _validate_loops(definition: "PipelineDefinition", id_set: set[str]) -> None:
    seen_from: set[str] = {b.from_ for b in definition.branches}
    for loop in definition.loops:
        if loop.from_ not in id_set:
            raise ValueError(f"loop '{loop.id}' from unknown node '{loop.from_}'")
        if loop.from_ in seen_from:
            raise ValueError(
                f"node '{loop.from_}' is the source of more than one branch/loop — "
                f"a node's outgoing routing can only be governed by one construct"
            )
        seen_from.add(loop.from_)

        if loop.back_to not in id_set:
            raise ValueError(f"loop '{loop.id}' back_to unknown node '{loop.back_to}'")
        if loop.exit_to != END_SENTINEL and loop.exit_to not in id_set:
            raise ValueError(
                f"loop '{loop.id}' exit_to unknown node '{loop.exit_to}' "
                f"(use the literal string \"END\" to exit the graph directly)"
            )


def _check_no_conflicting_conditional_edges(
    definition: "PipelineDefinition", id_set: set[str]
) -> None:
    """A node's OUTGOING edges must be either entirely plain (depends_on
    driven) or entirely conditional (branch/loop driven) — never both,
    since LangGraph doesn't support mixing a plain add_edge and a
    conditional add_conditional_edges from the same source node. If any
    OTHER node's depends_on names a conditional source, that edge would be
    silently dropped by the builder (which skips base-wiring for
    conditional sources) unless it's also a declared destination of that
    exact construct — catch that misconfiguration here instead."""
    conditional_sources = definition.conditional_sources

    allowed_destinations: dict[str, set[str]] = {}
    for branch in definition.branches:
        allowed_destinations.setdefault(branch.from_, set()).update(
            route.to for route in branch.routes
        )
    for loop in definition.loops:
        dests = {loop.back_to}
        if loop.exit_to != END_SENTINEL:
            dests.add(loop.exit_to)
        allowed_destinations.setdefault(loop.from_, set()).update(dests)

    for node in definition.nodes:
        for dep in node.depends_on:
            if dep in conditional_sources and node.id not in allowed_destinations.get(dep, set()):
                raise ValueError(
                    f"node '{node.id}' depends_on '{dep}', but '{dep}' is a branch/loop "
                    f"source — its outgoing edges are fully governed by that construct, "
                    f"so this depends_on entry would be silently unreachable. Either "
                    f"remove it, or add '{node.id}' as a declared destination of the "
                    f"branch/loop from '{dep}'."
                )


def _check_template_references(definition: "PipelineDefinition", id_set: set[str]) -> None:
    """Every {{ node_id.output }} (or bare `node_id` used in an `is
    defined` test) referenced in a node's prompt_template must be either:
      - declared in that node's depends_on (normal case), or
      - the `from_` node of a loop whose `back_to` is this node (the one
        case where a reference is legitimate without depends_on, since the
        loop mechanism — not depends_on — guarantees ordering; on the
        FIRST iteration this reference genuinely won't have run yet, which
        is exactly why templates in this position must use
        `{% if x is defined %}` around it).
    Anything else is a load-time error instead of a silent runtime bug
    (either an UndefinedError deep in a request, or worse, a literal
    unresolved placeholder silently sent to a model).
    """
    implicit_allowed: dict[str, set[str]] = {}
    for loop in definition.loops:
        implicit_allowed.setdefault(loop.back_to, set()).add(loop.from_)

    for node in definition.nodes:
        try:
            ast_tree = _template_parse_env.parse(node.prompt_template)
        except Exception as e:
            raise ValueError(f"node '{node.id}': invalid template syntax: {e}")

        referenced = meta.find_undeclared_variables(ast_tree)
        referenced.discard("input")

        allowed = set(node.depends_on) | implicit_allowed.get(node.id, set())

        for name in referenced:
            if name not in id_set:
                raise ValueError(
                    f"node '{node.id}' references undefined variable '{name}' "
                    f"in its prompt_template (not a node id, not 'input')"
                )
            if name not in allowed:
                raise ValueError(
                    f"node '{node.id}' references '{name}' in its prompt_template "
                    f"but doesn't declare '{name}' in depends_on (and it isn't a loop "
                    f"back-edge source) — add the edge or remove the reference"
                )
