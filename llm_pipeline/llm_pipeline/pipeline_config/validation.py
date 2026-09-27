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

from llm_pipeline.pipeline_config.activation import inputs_that_may_never_arrive
from llm_pipeline.pipeline_config.schema import JUDGE_VARIABLES, TEMPLATE_INPUT_VARIABLES
from llm_pipeline.pipeline_config.templates import undeclared_variables, unguarded_references
from llm_pipeline.pipeline_config.topology import Topology
from llm_pipeline.safe_eval import evaluate_condition, expression_names

if TYPE_CHECKING:
    from llm_pipeline.pipeline_config.schema import BranchConfig, PipelineDefinition


class PipelineValidationError(ValueError):
    """A DAG-level problem attributable to one specific node. Still a
    ValueError, so pydantic wraps it exactly as before — but carrying
    `node_id` lets the API tell an editor client WHICH node to highlight
    instead of making it parse the message."""

    def __init__(self, message: str, node_id: str | None = None) -> None:
        super().__init__(message)
        self.node_id = node_id


def validate_pipeline_dag(definition: "PipelineDefinition") -> None:
    """The single entry point — raises ValueError (wrapped into a pydantic
    ValidationError by the caller in schema.py) on the first problem found."""
    ids = [n.id for n in definition.nodes]

    if len(ids) != len(set(ids)):
        duplicates = {i for i in ids if ids.count(i) > 1}
        raise ValueError(f"duplicate node id(s): {', '.join(sorted(duplicates))}")

    id_set = set(ids)

    for node in definition.nodes:
        if node.id in TEMPLATE_INPUT_VARIABLES:
            raise PipelineValidationError(
                f"node id '{node.id}' is reserved (templates use {{{{ {node.id} }}}} for the "
                f"conversation) — rename the node",
                node.id,
            )
        if node.type == "llm_call" and node.model is None and definition.defaults.model is None:
            raise PipelineValidationError(
                f"node '{node.id}' has no model — set one on the node, or a default model "
                f"for the pipeline",
                node.id,
            )

    for node in definition.nodes:
        for dep in node.depends_on:
            if dep not in id_set:
                raise PipelineValidationError(
                    f"node '{node.id}' depends_on unknown node '{dep}'", node.id
                )
            if dep == node.id:
                raise PipelineValidationError(f"node '{node.id}' cannot depend on itself", node.id)

    for candidate in definition.output_node_candidates:
        if candidate not in id_set:
            raise ValueError(f"output_node '{candidate}' is not a defined node id")

    _check_for_cycles(definition, ids)
    _validate_branches(definition, id_set)
    _validate_loops(definition, id_set)
    # Built once the ids it indexes are known to be valid.
    topology = Topology(definition)
    _check_no_conflicting_conditional_edges(definition, topology)
    _check_template_references(definition, id_set)
    _check_outputs_that_may_be_missing(definition, topology)
    _validate_history(definition, id_set)
    _validate_tests(definition)

    if not topology.effective_roots:
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
                cycle = " -> ".join([*path, node_id, dep])
                raise PipelineValidationError(f"cycle detected in depends_on: {cycle}", node_id)
            if color[dep] == WHITE:
                visit(dep, [*path, node_id])
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
            for target in route.targets:
                if target not in id_set:
                    raise ValueError(f"branch '{branch.id}' routes to unknown node '{target}'")

        _check_routes_reachable_by_labels(definition, branch)


def _check_routes_reachable_by_labels(
    definition: "PipelineDefinition", branch: "BranchConfig"
) -> None:
    """When the branch's source is a classifier, its output is always one
    of its labels — so a route no label reaches (a typo'd label, or one an
    earlier route always catches first) is a mistake, caught here rather
    than by requests silently taking the default route."""
    source = next(n for n in definition.nodes if n.id == branch.from_)
    if source.labels is None:
        return
    conditional = [(r, r.when) for r in branch.routes if r.when is not None]
    # A route that also reads `question` may or may not match any label —
    # it's neither checked nor assumed to catch the labels it could match.
    judged = ["question" not in expression_names(when) for _, when in conditional]
    taken: set[int] = set()
    for label in source.labels:
        # Routes are tried in order; the first match wins.
        for i, (_, when) in enumerate(conditional):
            if judged[i] and evaluate_condition(when, label):
                taken.add(i)
                break
    for i, (route, _) in enumerate(conditional):
        if judged[i] and i not in taken:
            raise ValueError(
                f"branch '{branch.id}': the route to {', '.join(route.targets)} can never "
                f"be taken — "
                f"'{branch.from_}' only answers {', '.join(source.labels)}, and none of "
                f"them reaches `{route.when}`"
            )


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
        if loop.exit_node is not None and loop.exit_node not in id_set:
            raise ValueError(
                f"loop '{loop.id}' exit_to unknown node '{loop.exit_to}' "
                f'(use the literal string "END" to exit the graph directly)'
            )


def _check_no_conflicting_conditional_edges(
    definition: "PipelineDefinition", topology: Topology
) -> None:
    """A node's OUTGOING edges must be either entirely plain (depends_on
    driven) or entirely conditional (branch/loop driven) — never both,
    since LangGraph doesn't support mixing a plain add_edge and a
    conditional add_conditional_edges from the same source node. If any
    OTHER node's depends_on names a conditional source, that edge would be
    silently dropped by the builder (which skips base-wiring for
    conditional sources) unless it's also a declared destination of that
    exact construct — catch that misconfiguration here instead."""
    for node in definition.nodes:
        for dep in node.depends_on:
            if (
                dep in topology.conditional_sources
                and node.id not in topology.declared_destinations(dep)
            ):
                raise PipelineValidationError(
                    f"node '{node.id}' depends_on '{dep}', but '{dep}' is a branch/loop "
                    f"source — its outgoing edges are fully governed by that construct, "
                    f"so this depends_on entry would be silently unreachable. Either "
                    f"remove it, or add '{node.id}' as a declared destination of the "
                    f"branch/loop from '{dep}'.",
                    node.id,
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
            referenced = undeclared_variables(node.prompt_template)
        except Exception as e:
            raise PipelineValidationError(
                f"node '{node.id}': invalid template syntax: {e}", node.id
            ) from e

        referenced -= TEMPLATE_INPUT_VARIABLES

        allowed = set(node.depends_on) | implicit_allowed.get(node.id, set())

        for name in referenced:
            if name not in id_set:
                raise PipelineValidationError(
                    f"node '{node.id}' references undefined variable '{name}' "
                    f"in its prompt_template (not a node id, not 'input')",
                    node.id,
                )
            if name not in allowed:
                raise PipelineValidationError(
                    f"node '{node.id}' references '{name}' in its prompt_template "
                    f"but doesn't declare '{name}' in depends_on (and it isn't a loop "
                    f"back-edge source) — add the edge or remove the reference",
                    node.id,
                )


def _check_outputs_that_may_be_missing(
    definition: "PipelineDefinition", topology: Topology
) -> None:
    """A prompt must guard ({% if x is defined %}) every output that is
    certain to be missing on some run of its node — otherwise those runs
    fail halfway through a request. Two cases are certain:
      - a loop's back_to reads its from_ node: not run yet on the first pass
      - a join reads an input behind a branch route its other inputs don't
        need: on requests that take another route, that input never runs
    (Other timing-dependent cases are left to the run-time error.)"""
    reasons: dict[str, dict[str, str]] = {}
    for node_id, inputs in inputs_that_may_never_arrive(topology).items():
        for name in inputs:
            reasons.setdefault(node_id, {})[name] = (
                f"'{name}' is behind a branch route its other inputs don't need, "
                f"so on some requests it never runs"
            )
    for loop in definition.loops:
        reasons.setdefault(loop.back_to, {})[loop.from_] = (
            f"on the loop's first pass '{loop.from_}' hasn't run yet"
        )

    for node in definition.nodes:
        possibly_missing = reasons.get(node.id)
        if not possibly_missing:
            continue
        for name in sorted(unguarded_references(node.prompt_template, set(possibly_missing))):
            raise PipelineValidationError(
                f"node '{node.id}' uses {name}'s output without a guard, but "
                f"{possibly_missing[name]} — wrap that part in "
                f"{{% if {name} is defined %}}…{{% endif %}}",
                node.id,
            )


def _check_template_variables(source: str, allowed: set[str], where: str) -> set[str]:
    try:
        referenced = undeclared_variables(source)
    except Exception as e:
        raise ValueError(f"{where}: invalid template syntax: {e}") from e
    unknown = referenced - allowed
    if unknown:
        raise ValueError(
            f"{where}: unknown variable(s) {', '.join(sorted(unknown))} "
            f"(available: {', '.join(sorted(allowed))})"
        )
    return referenced


def _validate_history(definition: "PipelineDefinition", id_set: set[str]) -> None:
    history = definition.history
    for node_id in history.remember:
        if node_id not in id_set:
            raise ValueError(f"history.remember names unknown node '{node_id}'")
    _check_template_variables(
        history.turn_template, {"prompt", "answer", "outputs"}, "history.turn_template"
    )
    if history.summarize is not None:
        used = _check_template_variables(
            history.summarize.prompt, {"history"}, "history.summarize.prompt"
        )
        if "history" not in used:
            raise ValueError(
                "history.summarize.prompt must include {{ history }} — the turns to summarize"
            )


def _validate_tests(definition: "PipelineDefinition") -> None:
    tests = definition.tests
    seen: set[str] = set()
    for case in tests.cases:
        if case.name in seen:
            raise ValueError(f"tests: two cases are named '{case.name}'")
        seen.add(case.name)
    if tests.judge is None:
        judged = next((c.name for c in tests.cases for e in c.expect if e.judge), None)
        if judged is not None:
            raise ValueError(
                f"tests: case '{judged}' has a judge expectation but no tests.judge model is set"
            )
    else:
        used = _check_template_variables(
            tests.judge.prompt, set(JUDGE_VARIABLES), "tests.judge.prompt"
        )
        for needed in ("answer", "criterion"):
            if needed not in used:
                raise ValueError(f"tests.judge.prompt must include {{{{ {needed} }}}}")
