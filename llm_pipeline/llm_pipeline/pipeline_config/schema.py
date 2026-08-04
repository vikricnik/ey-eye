"""
Pipeline YAML schema — pure Pydantic model definitions.

Cross-field, whole-DAG validation (cycle detection, branch/loop consistency,
template reference checking) deliberately does NOT live here — see
validation.py for that. This module only contains:
  - simple, single-model field validators (e.g. "a branch route needs
    either `when` or `default`, not both") that only ever need `self`
  - the model shapes themselves

Keeping DAG-level validation as standalone functions in a separate module
(rather than sprawling `@model_validator` methods) makes those checks
independently testable and reusable without needing to go through
Pydantic's validation lifecycle — see validation.py's own docstring.
"""

from typing import Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

from llm_pipeline.providers import ProviderType
from llm_pipeline.safe_eval import UnsafeExpressionError, validate_expression_syntax


class ExecutionConfig(BaseModel):
    model_timeout_seconds: float = 60.0
    max_history_turns: int = 6
    # Total attempts per model call = max_retries + 1 (the initial try).
    # Only transient failures (ProviderError — timeouts, connection errors,
    # API errors) are retried; retries compose with the circuit breaker in
    # providers/resilience.py, which can short-circuit these entirely for a
    # model that's failing consistently rather than retrying it every time.
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
    # directly once the loop exits (see dag_builder/loops.py for how this
    # composes with the pipeline's output_node resolution).
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
        branch targets; see effective_root_ids for the version dag_builder
        should actually use as entry points."""
        return [n.id for n in self.nodes if not n.depends_on]

    @property
    def effective_root_ids(self) -> list[str]:
        """Entry points dag_builder should wire the graph's start to.
        Excludes branch route targets: those have depends_on=[] (nothing
        upstream in the base DAG) but must NEVER run except when the branch
        actually routes to them — including them as automatic entry points
        would run them unconditionally at the very start of every request,
        which defeats the entire point of a branch being conditional."""
        return [nid for nid in self.root_node_ids if nid not in self.branch_targets]

    @model_validator(mode="after")
    def validate_dag(self) -> "PipelineDefinition":
        # Deferred import: validation.py needs PipelineDefinition only for
        # a type hint (guarded under TYPE_CHECKING there), so at RUNTIME
        # there's no cycle — but importing it at call time here rather than
        # module load time is what makes that safe regardless of import
        # order between this module and validation.py.
        from llm_pipeline.pipeline_config.validation import validate_pipeline_dag

        validate_pipeline_dag(self)
        return self
