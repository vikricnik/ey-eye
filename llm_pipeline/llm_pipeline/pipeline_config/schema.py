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

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from llm_pipeline.pipeline_config.upgrade import (
    SCHEMA_VERSION,
    upgraded_model_block,
    upgraded_pipeline,
)
from llm_pipeline.providers.base import OllamaOptions, ProviderType
from llm_pipeline.safe_eval import UnsafeExpressionError, validate_expression_syntax

# Every model below forbids unknown fields: a typo'd key (e.g. `temprature`)
# is rejected with a message naming it rather than silently ignored — the
# same rule whether the definition came from a YAML file on disk or from an
# editor client over the API, since both go through these same models.
_STRICT = ConfigDict(extra="forbid")

# A loop's exit_to that ends the run instead of continuing at a node.
END_SENTINEL = "END"

# Used when neither the node nor the pipeline's defaults set a temperature.
DEFAULT_TEMPERATURE = 0.2

# How each earlier conversation turn is written into the history. Renders to
# exactly the historical fixed format ("User: …\nAssistant: …") when no node
# outputs are remembered.
DEFAULT_TURN_TEMPLATE = (
    "User: {{ prompt }}\n"
    "{% for node, text in outputs.items() %}{{ node }}: {{ text }}\n{% endfor %}"
    "Assistant: {{ final_answer }}"
)
# Variables of a turn template: the names of a ConversationTurn's fields.
# `answer` is the older name of `final_answer`.
TURN_TEMPLATE_VARIABLES = frozenset({"prompt", "final_answer", "answer", "outputs"})
DEFAULT_HISTORY_INTRO = "Conversation so far:"
DEFAULT_SUMMARY_PROMPT = (
    "Summarize this conversation briefly. Keep names, facts, decisions and open "
    "questions; drop small talk.\n\n{{ history }}"
)

# Template variables every node prompt can use, besides other nodes' outputs:
# {{ message }} (the new message alone), {{ conversation }} (the earlier
# turns, then the new message — just the message for a node that doesn't see
# the history) and {{ history }} (the earlier turns alone). {{ question }} and
# {{ input }} are older names for {{ message }} and {{ conversation }}.
TEMPLATE_INPUT_VARIABLES = frozenset({"message", "conversation", "history", "question", "input"})

# How a judge model is asked whether a test case's answer meets one
# requirement (a `judge:` expectation). Variables: question (or message) —
# the case's message —, answer, requirement (`criterion` is its older name).
DEFAULT_JUDGE_PROMPT = (
    "You are checking an answer against one requirement.\n\n"
    "Question: {{ question }}\n\n"
    "Answer: {{ answer }}\n\n"
    "Requirement: {{ requirement }}\n\n"
    "Reply with PASS or FAIL on the first line, then one sentence saying why."
)
JUDGE_VARIABLES = frozenset({"question", "message", "answer", "requirement", "criterion"})


class ExecutionConfig(BaseModel):
    model_config = _STRICT
    model_timeout_seconds: float = Field(default=60.0, gt=0)
    # Total attempts per model call = max_retries + 1 (the initial try).
    # Only transient failures (ProviderError — timeouts, connection errors,
    # API errors) are retried; retries compose with the circuit breaker in
    # providers/resilience.py, which can short-circuit these entirely for a
    # model that's failing consistently rather than retrying it every time.
    max_retries: int = Field(default=1, ge=0)
    retry_backoff_seconds: float = Field(default=1.0, ge=0)
    # At most this many nodes call their models at the same time (None: no
    # limit — every node whose inputs are ready starts immediately).
    max_concurrency: int | None = Field(default=None, ge=1)
    # The whole run's limit: model_timeout_seconds bounds each call, but a
    # run is many calls — retried, some in loops. Past this the run is
    # stopped, model calls in flight included (None: no limit).
    run_timeout_seconds: float | None = Field(default=None, gt=0)


class NodeModelConfig(BaseModel):
    model_config = _STRICT
    provider: ProviderType
    # The model's name at the provider, e.g. "llama3.2:3b" (version 1 of
    # the schema called it `model` — see upgrade.py).
    name: str = Field(min_length=1)
    # None: inherit the pipeline default's temperature, else DEFAULT_TEMPERATURE.
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    # Provider-specific generation options. Only Ollama has any today; see
    # OllamaOptions (providers/base.py) for the full list.
    options: OllamaOptions | None = None

    @model_validator(mode="before")
    @classmethod
    def _accept_version_1(cls, data: object) -> object:
        return upgraded_model_block(data)

    @model_validator(mode="after")
    def options_only_for_ollama(self) -> "NodeModelConfig":
        # Rejected rather than ignored: options on a provider that can't
        # apply them would otherwise look configured while doing nothing.
        if self.options is not None and self.provider != ProviderType.OLLAMA:
            raise ValueError(
                f"'options' are only supported for provider 'ollama', "
                f"not '{self.provider.value}'"
            )
        return self


class NodeLayout(BaseModel):
    """Where the visual editor draws this node. Pure presentation — the
    graph builder never reads it."""

    model_config = _STRICT
    x: float
    y: float


class NodeConfig(BaseModel):
    model_config = _STRICT
    id: str
    # Forward-compatible: today only llm_call is implemented, but the field
    # exists now so retrieval/tool/human_approval node types can be added
    # later without changing the schema shape of every existing pipeline.
    type: Literal["llm_call"] = "llm_call"
    depends_on: list[str] = Field(default_factory=list[str])
    # None: use the pipeline's `defaults.model` (validation.py requires one
    # of the two for an llm_call node).
    model: NodeModelConfig | None = None
    # Sent as a real system message, separate from the rendered prompt.
    # Plain text — not a template, so it can't reference other nodes.
    # None: use the pipeline's `defaults.system_prompt`.
    system_prompt: str | None = None
    prompt_template: str
    # False: this node doesn't see the conversation — its {{ conversation }}
    # is just the new message and {{ history }} is empty.
    include_history: bool = True
    # Remove <think>…</think> reasoning from this node's output before other
    # nodes or the user see it. None: use the pipeline's default.
    strip_reasoning: bool | None = None
    # Makes this node a classifier: its output becomes exactly one of these
    # labels (see dag_builder/labels.py), and the run fails if the model's
    # answer names none of them — so branches can route on `output == "X"`.
    labels: list[str] | None = None
    layout: NodeLayout | None = None

    @field_validator("labels")
    @classmethod
    def labels_are_distinct(cls, labels: list[str] | None) -> list[str] | None:
        if labels is None:
            return None
        if len(labels) < 2:
            raise ValueError("a classifier needs at least 2 labels")
        seen: set[str] = set()
        for label in labels:
            if not label.strip():
                raise ValueError("labels cannot be empty")
            if label.casefold() in seen:
                raise ValueError(f"label '{label}' appears more than once")
            seen.add(label.casefold())
        return labels


class NodeDefaults(BaseModel):
    """Settings every node inherits unless it sets its own. A node without a
    `model` uses this whole model block; a node with its own model still
    inherits the temperature (if it sets none) and, when both are Ollama,
    any Ollama options it doesn't set itself."""

    model_config = _STRICT
    model: NodeModelConfig | None = None
    system_prompt: str | None = None
    strip_reasoning: bool = False


class HistorySummaryConfig(BaseModel):
    """Condense earlier turns that no longer fit (beyond `max_turns` or the
    character budget) into a short recap, with this model."""

    model_config = _STRICT
    model: NodeModelConfig
    # Template; {{ history }} is the earlier turns being condensed.
    prompt: str = DEFAULT_SUMMARY_PROMPT


class HistoryConfig(BaseModel):
    """How earlier conversation turns reach the nodes."""

    model_config = _STRICT
    # How many of the latest turns are kept verbatim.
    max_turns: int = Field(default=6, ge=0)
    # First line of the history block inside {{ conversation }}.
    intro: str = DEFAULT_HISTORY_INTRO
    # Template for one earlier turn; variables: prompt, final_answer,
    # outputs (the remembered node outputs of that turn, by node id).
    turn_template: str = DEFAULT_TURN_TEMPLATE
    # Character budget for the verbatim turns; the oldest go first.
    max_chars: int | None = Field(default=None, ge=200)
    summarize: HistorySummaryConfig | None = None
    # Node ids whose outputs are remembered with each turn (besides the
    # final answer), available to turn_template as outputs.<node>.
    remember: list[str] = Field(default_factory=list[str])


class EvalExpectation(BaseModel):
    """One thing a test case's answer must satisfy — exactly one of these."""

    model_config = _STRICT
    contains: str | None = None  # case-insensitive
    not_contains: str | None = None  # case-insensitive
    check: str | None = None  # a condition on `output`, like a branch's `when`
    judge: str | None = None  # a requirement the judge model grades

    @model_validator(mode="after")
    def exactly_one(self) -> "EvalExpectation":
        options = ("contains", "not_contains", "check", "judge")
        kinds = [k for k in options if getattr(self, k) is not None]
        if len(kinds) != 1:
            raise ValueError(
                "an expectation needs exactly one of contains, not_contains, check, judge"
            )
        if not str(getattr(self, kinds[0])).strip():
            raise ValueError(f"a '{kinds[0]}' expectation needs a value")
        if self.check is not None:
            try:
                validate_expression_syntax(self.check)
            except (SyntaxError, UnsafeExpressionError) as e:
                raise ValueError(f"invalid check {self.check!r}: {e}") from e
        return self


class EvalCase(BaseModel):
    """A message to run the pipeline with (no conversation before it), and
    what its answer must satisfy — nothing, to just see the answer."""

    model_config = _STRICT
    name: str = Field(min_length=1)
    input: str = Field(min_length=1)
    expect: list[EvalExpectation] = Field(default_factory=list[EvalExpectation])


class EvalJudge(BaseModel):
    """The model that grades `judge` expectations, PASS or FAIL."""

    model_config = _STRICT
    model: NodeModelConfig
    prompt: str = DEFAULT_JUDGE_PROMPT


class TestsConfig(BaseModel):
    """The pipeline's test cases. The engine ignores them; editor clients
    run them (POST /v1/drafts/test-runs) to check the pipeline and compare
    models."""

    __test__ = False  # not a pytest test class, despite the name
    model_config = _STRICT
    judge: EvalJudge | None = None
    cases: list[EvalCase] = Field(default_factory=list[EvalCase])


class BranchRoute(BaseModel):
    model_config = _STRICT
    when: str | None = None
    default: bool = False
    # One node, or several that all start (in parallel) when this route is
    # taken. Kept as written so files round-trip unchanged; use `targets`.
    to: str | list[str]

    @property
    def targets(self) -> list[str]:
        return [self.to] if isinstance(self.to, str) else self.to

    @field_validator("to")
    @classmethod
    def targets_are_distinct(cls, to: str | list[str]) -> str | list[str]:
        if isinstance(to, list):
            if not to:
                raise ValueError("a route needs at least one target")
            duplicate = next((t for i, t in enumerate(to) if t in to[:i]), None)
            if duplicate is not None:
                raise ValueError(f"route lists '{duplicate}' more than once")
        return to

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
                raise ValueError(f"invalid 'when' expression {self.when!r}: {e}") from e
        return self


class BranchConfig(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
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
    model_config = ConfigDict(populate_by_name=True, extra="forbid")
    id: str
    from_: str = Field(alias="from")
    back_to: str
    # A real node id, or END_SENTINEL to end the run once the loop exits
    # (see dag_builder/loops.py for how this composes with the pipeline's
    # output_nodes resolution).
    exit_to: str
    exit_when: str
    max_iterations: int = Field(default=3, ge=1)
    on_max_iterations: Literal["proceed", "fail"] = "proceed"

    @property
    def exit_node(self) -> str | None:
        """The node the run continues at once the loop exits; None when the
        loop ends the run — even if some node happens to be named END."""
        return None if self.exit_to == END_SENTINEL else self.exit_to

    @model_validator(mode="after")
    def validate_exit_when_syntax(self) -> "LoopConfig":
        try:
            validate_expression_syntax(self.exit_when)
        except (SyntaxError, UnsafeExpressionError) as e:
            raise ValueError(f"loop '{self.id}': invalid exit_when {self.exit_when!r}: {e}") from e
        return self


class PipelineDefinition(BaseModel):
    model_config = _STRICT
    # Bump when the YAML shape changes in a way that isn't backward
    # compatible — and teach upgrade.py to read the previous version.
    version: int = SCHEMA_VERSION
    name: str
    description: str = ""
    execution: ExecutionConfig = ExecutionConfig()
    defaults: NodeDefaults = NodeDefaults()
    history: HistoryConfig = HistoryConfig()
    nodes: list[NodeConfig] = Field(min_length=1)
    branches: list[BranchConfig] = Field(default_factory=list[BranchConfig])
    loops: list[LoopConfig] = Field(default_factory=list[LoopConfig])
    # The node whose output is the answer — or, when `branches` mean only
    # ONE of several possible "final" nodes runs for a given request,
    # candidates in priority order: the first one that ran answers.
    output_nodes: list[str] = Field(min_length=1)
    tests: TestsConfig = TestsConfig()

    @model_validator(mode="before")
    @classmethod
    def _accept_version_1(cls, data: object) -> object:
        return upgraded_pipeline(data)

    @property
    def root_node_ids(self) -> list[str]:
        """Plain DAG roots — nodes with no depends_on. NOT adjusted for
        branch targets; Topology.effective_roots is what the graph actually
        starts from."""
        return [n.id for n in self.nodes if not n.depends_on]

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
