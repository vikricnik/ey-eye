"""
YAML pipeline definitions.

A pipeline is a DAG of `nodes` connected by `depends_on` edges — see the
module docstring in dag_builder.py for what that gives you for free
(parallel siblings, automatic joins).

Two additional, deliberately separate mechanisms layer conditional control
flow on top of that base DAG, both using LangGraph's conditional-edge
support under the hood:

  `branches` — a node's output picks exactly ONE of several downstream
  paths (mutually exclusive; the other paths never execute for that request).

  `loops` — a bounded generate -> critique -> revise cycle: a node's output
  decides whether to loop back to an earlier node or exit forward, up to
  `max_iterations` times.

Both use the same small sandboxed expression language (safe_eval.py) for
their conditions — never raw eval().

See llm_pipeline/README.md for the full schema reference and worked examples.
"""

from pathlib import Path
from typing import Literal, Union
import yaml
from pydantic import BaseModel, Field, ConfigDict, model_validator
from jinja2 import Environment, meta

from llm_pipeline.providers import ProviderType
from llm_pipeline.safe_eval import validate_expression_syntax, UnsafeExpressionError
from llm_pipeline.models import PipelineSummary

_template_parse_env = Environment()

# The literal sentinel meaning "route straight to the end of the graph"
# rather than to another named node.
END_SENTINEL = "END"


class ExecutionConfig(BaseModel):
    model_timeout_seconds: float = 60.0
    max_history_turns: int = 6
    # Total attempts per model call = max_retries + 1 (the initial try).
    # Only transient failures (ProviderError — timeouts, connection errors,
    # API errors) are retried; retries compose with the circuit breaker in
    # providers.py, which can short-circuit these entirely for a model
    # that's failing consistently rather than retrying it every single time.
    max_retries: int = 1
    retry_backoff_seconds: float = 1.0


class NodeModelConfig(BaseModel):
    provider: ProviderType
    model: str
    temperature: float = 0.2


class NodeConfig(BaseModel):
    id: str
    # Forward-compatible: today only llm_call is implemented, but the field
    # exists now so retrieval/tool/human_approval node types can be added
    # later without changing the schema shape of every existing pipeline.
    type: Literal["llm_call"] = "llm_call"
    depends_on: list[str] = Field(default_factory=list[str])
    # Optional, not required: only llm_call needs a model block today, but
    # future non-llm_call node types (retrieval, tool, ...) genuinely won't
    # have one — see model_required_for_llm_call below, which is the actual
    # enforcement point for llm_call specifically.
    model: NodeModelConfig | None = None
    prompt_template: str

    @model_validator(mode="after")
    def model_required_for_llm_call(self) -> "NodeConfig":
        if self.type == "llm_call" and self.model is None:
            raise ValueError(f"node '{self.id}': type=llm_call requires a 'model' block")
        return self


class BranchRoute(BaseModel):
    when: str | None = None
    default: bool = False
    to: str

    @model_validator(mode="after")
    def when_xor_default(self) -> "BranchRoute":
        if self.default and self.when is not None:
            raise ValueError("a route cannot set both 'default: true' and 'when'")
        if not self.default and self.when is None:
            raise ValueError("a non-default route must specify 'when'")
        if self.when is not None:
            try:
                validate_expression_syntax(self.when)
            except (SyntaxError, UnsafeExpressionError) as e:
                raise ValueError(f"invalid 'when' expression {self.when!r}: {e}")
        return self


class BranchConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    from_: str = Field(alias="from")
    routes: list[BranchRoute] = Field(min_length=1)

    @model_validator(mode="after")
    def exactly_one_default(self) -> "BranchConfig":
        defaults = [r for r in self.routes if r.default]
        if len(defaults) != 1:
            raise ValueError(
                f"branch '{self.id}' must have exactly one default route, found {len(defaults)}"
            )
        return self


class LoopConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    from_: str = Field(alias="from")
    back_to: str
    # A real node id, or the literal string "END" to terminate the graph
    # directly once the loop exits (see dag_builder.py for how this composes
    # with the pipeline's output_node resolution).
    exit_to: str
    exit_when: str
    max_iterations: int = Field(default=3, ge=1)
    on_max_iterations: Literal["proceed", "fail"] = "proceed"

    @model_validator(mode="after")
    def validate_exit_when_syntax(self) -> "LoopConfig":
        try:
            validate_expression_syntax(self.exit_when)
        except (SyntaxError, UnsafeExpressionError) as e:
            raise ValueError(f"loop '{self.id}': invalid exit_when {self.exit_when!r}: {e}")
        return self


class PipelineDefinition(BaseModel):
    # Bump when the YAML shape changes in a way that isn't backward compatible.
    version: int = 1
    name: str
    description: str = ""
    execution: ExecutionConfig = ExecutionConfig()
    nodes: list[NodeConfig] = Field(min_length=1)
    branches: list[BranchConfig] = Field(default_factory=list[BranchConfig])
    loops: list[LoopConfig] = Field(default_factory=list[LoopConfig])
    # A single node id, or a list of candidate node ids in priority order —
    # a list is required once `branches` means only ONE of several possible
    # "final" nodes actually runs for a given request (the others in that
    # branch never execute, so a single fixed output_node can't work).
    output_node: Union[str, list[str]]

    @property
    def output_node_candidates(self) -> list[str]:
        return [self.output_node] if isinstance(self.output_node, str) else self.output_node

    @property
    def branch_targets(self) -> set[str]:
        return {route.to for b in self.branches for route in b.routes}

    @property
    def conditional_sources(self) -> set[str]:
        """Node ids whose ENTIRE outgoing routing is governed by a branch or
        loop's conditional dispatch — no plain depends_on-based edge may
        originate from these, since LangGraph doesn't support mixing a plain
        edge and a conditional edge from the same source node."""
        return {b.from_ for b in self.branches} | {l.from_ for l in self.loops}

    @property
    def root_node_ids(self) -> list[str]:
        """Plain DAG roots — nodes with no depends_on. NOT yet adjusted for
        branch targets; see effective_root_ids for the version dag_builder.py
        should actually use as entry points."""
        return [n.id for n in self.nodes if not n.depends_on]

    @property
    def effective_root_ids(self) -> list[str]:
        """Entry points dag_builder.py should wire the graph's start to.
        Excludes branch route targets: those have depends_on=[] (nothing
        upstream in the base DAG) but must NEVER run except when the branch
        actually routes to them — including them as automatic entry points
        would run them unconditionally at the very start of every request,
        which defeats the entire point of a branch being conditional."""
        return [nid for nid in self.root_node_ids if nid not in self.branch_targets]

    @model_validator(mode="after")
    def validate_dag(self) -> "PipelineDefinition":
        ids = [n.id for n in self.nodes]

        if len(ids) != len(set(ids)):
            duplicates = {i for i in ids if ids.count(i) > 1}
            raise ValueError(f"duplicate node id(s): {', '.join(sorted(duplicates))}")

        id_set = set(ids)

        for node in self.nodes:
            for dep in node.depends_on:
                if dep not in id_set:
                    raise ValueError(f"node '{node.id}' depends_on unknown node '{dep}'")
                if dep == node.id:
                    raise ValueError(f"node '{node.id}' cannot depend on itself")

        for candidate in self.output_node_candidates:
            if candidate not in id_set:
                raise ValueError(f"output_node '{candidate}' is not a defined node id")

        self._check_for_cycles(ids)
        self._validate_branches(id_set)
        self._validate_loops(id_set)
        self._check_no_conflicting_conditional_edges(id_set)
        self._check_template_references(id_set)

        if not self.effective_root_ids:
            raise ValueError(
                "pipeline has no entry point — every node with no dependencies "
                "is exclusively a branch route target"
            )

        return self

    def _check_for_cycles(self, ids: list[str]) -> None:
        """Cycle check over `depends_on` ONLY — loops are a deliberately
        separate mechanism (see module docstring) and are allowed, indeed
        expected, to introduce real cycles in the compiled graph. Allowing
        that here would defeat the point of keeping depends_on a validated
        DAG that's easy to reason about independent of control flow."""
        WHITE, GRAY, BLACK = 0, 1, 2
        color: dict[str, int] = {node_id: WHITE for node_id in ids}
        deps: dict[str, list[str]] = {n.id: n.depends_on for n in self.nodes}

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

    def _validate_branches(self, id_set: set[str]) -> None:
        seen_from: set[str] = set()
        for branch in self.branches:
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
                    raise ValueError(
                        f"branch '{branch.id}' routes to unknown node '{route.to}'"
                    )

    def _validate_loops(self, id_set: set[str]) -> None:
        seen_from: set[str] = {b.from_ for b in self.branches}
        for loop in self.loops:
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

    def _check_no_conflicting_conditional_edges(self, id_set: set[str]) -> None:
        """A node's OUTGOING edges must be either entirely plain (depends_on
        driven) or entirely conditional (branch/loop driven) — never both,
        since LangGraph doesn't support mixing a plain add_edge and a
        conditional add_conditional_edges from the same source node. If any
        OTHER node's depends_on names a conditional source, that edge would
        be silently dropped by the builder (which skips base-wiring for
        conditional sources) unless it's also a declared destination of
        that exact construct — catch that misconfiguration here instead."""
        conditional_sources = self.conditional_sources

        allowed_destinations: dict[str, set[str]] = {}
        for branch in self.branches:
            allowed_destinations.setdefault(branch.from_, set()).update(
                route.to for route in branch.routes
            )
        for loop in self.loops:
            dests = {loop.back_to}
            if loop.exit_to != END_SENTINEL:
                dests.add(loop.exit_to)
            allowed_destinations.setdefault(loop.from_, set()).update(dests)

        for node in self.nodes:
            for dep in node.depends_on:
                if dep in conditional_sources and node.id not in allowed_destinations.get(dep, set()):
                    raise ValueError(
                        f"node '{node.id}' depends_on '{dep}', but '{dep}' is a branch/loop "
                        f"source — its outgoing edges are fully governed by that construct, "
                        f"so this depends_on entry would be silently unreachable. Either "
                        f"remove it, or add '{node.id}' as a declared destination of the "
                        f"branch/loop from '{dep}'."
                    )

    def _check_template_references(self, id_set: set[str]) -> None:
        """Every {{ node_id.output }} (or bare `node_id` used in an `is
        defined` test) referenced in a node's prompt_template must be either:
          - declared in that node's depends_on (normal case), or
          - the `from_` node of a loop whose `back_to` is this node (the one
            case where a reference is legitimate without depends_on, since
            the loop mechanism — not depends_on — guarantees ordering; on
            the FIRST iteration this reference genuinely won't have run yet,
            which is exactly why templates in this position must use
            `{% if x is defined %}` around it).
        Anything else is a load-time error instead of a silent runtime bug
        (either an UndefinedError deep in a request, or worse, a literal
        unresolved placeholder silently sent to a model).
        """
        implicit_allowed: dict[str, set[str]] = {}
        for loop in self.loops:
            implicit_allowed.setdefault(loop.back_to, set()).add(loop.from_)

        for node in self.nodes:
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


def load_pipeline_definition(path: Path) -> PipelineDefinition:
    """Loads and fully validates a pipeline YAML file. Raises pydantic's
    ValidationError (wrapping any of the checks above) on anything invalid."""
    with open(path) as f:
        raw = yaml.safe_load(f)
    return PipelineDefinition.model_validate(raw)


def list_available_pipelines(directory: Path) -> list[PipelineSummary]:
    """Every loadable pipeline in a directory — used by GET /pipelines.
    Files that fail to load are skipped rather than crashing the whole
    listing; run validation in CI to catch those before deploy."""
    results: list[PipelineSummary] = []
    for yaml_path in sorted(directory.glob("*.yaml")):
        try:
            definition = load_pipeline_definition(yaml_path)
        except Exception:
            continue
        results.append(
            PipelineSummary(
                name=definition.name,
                description=definition.description,
                filename=yaml_path.name,
            )
        )
    return results
