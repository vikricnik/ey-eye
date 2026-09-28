"""
The public API contract — every model that actually crosses the wire:
request bodies, response bodies, error bodies. Anything here is effectively
a promise to API consumers (the CLI, the web client, anyone else); changing
a field name or type here is a breaking change in a way that changing
state.py's internal PipelineState shape is not.
"""

from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# Shared with history.py, which doesn't import this wire contract.
from llm_pipeline.conversation import ConversationTurn as ConversationTurn


class RerunRequest(BaseModel):
    """Run again from one node: it and every node after it call their
    models; every other node reuses its output from `outputs` (typically
    the previous run's node outputs). Send the same prompt and history as
    that run."""

    from_node: str
    outputs: dict[str, str] = {}


class AskRequest(BaseModel):
    prompt: str
    # Pipeline selection is stateless and per-request rather than a server-side
    # "active pipeline" — every worker process loads the same YAML files from
    # the same disk independently; there's no shared mutable state to
    # disagree about across multiple uvicorn workers.
    pipeline_name: str
    history: list[ConversationTurn] = []
    rerun: RerunRequest | None = None


class UsageDTO(BaseModel):
    """What the model's backend reported for a node's call (its last one,
    for a node a loop re-ran). Any field may be null when not reported."""

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    # Time spent generating the reply (excludes loading the model and
    # reading the prompt): completion_tokens / generation_ms is its speed.
    generation_ms: float | None = None
    # How many tokens the model could see: the node's num_ctx, else the
    # context the loaded Ollama model runs with. A prompt at (or near) this
    # size was probably cut off — Ollama drops the start of longer prompts.
    # Null when unknown (e.g. cloud providers).
    context_window: int | None = None
    # Characters sent (prompt + system prompt). prompt_tokens is counted
    # AFTER Ollama cuts a prompt that doesn't fit — often to about half the
    # window — so a prompt far longer than the window can still show a
    # modest token count; clients compare both.
    prompt_chars: int | None = None


class NodeOutputDTO(BaseModel):
    node_id: str
    model_name: str
    output: str
    duration_ms: float
    usage: UsageDTO | None = None
    # Reused from the previous run by a re-run, not generated now.
    replayed: bool = False


class AskResponse(BaseModel):
    pipeline_name: str
    output_node: str  # whichever output_node candidate actually resolved
    final_answer: str
    node_outputs: dict[str, NodeOutputDTO]
    loop_iterations: dict[str, int] = {}
    # Outputs of the nodes in the pipeline's `history.remember`: store them
    # with this turn and send them back as its `outputs` next time.
    remembered: dict[str, str] = {}


# ---------------------------------------------------------------------------
# Streaming (POST /ask/stream) — Server-Sent Events, one event per line below
# ---------------------------------------------------------------------------
#
# Node-level streaming, not token-level: each event fires when a graph node
# FINISHES, not as an individual LLM streams its own tokens. This works
# uniformly across every provider (Ollama/OpenAI/Anthropic/Gemini/Copilot)
# via LangGraph's own astream() without needing each provider adapter to
# implement token streaming individually — see dag_builder's module docs
# for why that's a deliberately separate, larger undertaking left for later.
#
# Wire format per event:
#   event: <event_type>
#   data: <one of the models below, JSON-encoded>
#   \n
# (blank line terminates each event, per the SSE spec)


class NodeStartEvent(BaseModel):
    """A pipeline-defined node just started calling its model. Emitted by
    the node itself, so it is exact: parallel siblings each get their own
    event as they genuinely start, and a node re-run by a loop emits one
    per iteration. Always followed by that node's node_complete, or by an
    error event naming it."""

    node_id: str
    model_name: str
    # 1 for the first try; 2+ when the node is retrying after a failed model
    # call — clients should discard any streamed text from earlier attempts.
    attempt: int = 1
    # What the model receives: the prompt template rendered with the run's
    # input and its dependencies' outputs, and the node's system prompt.
    prompt: str | None = None
    system: str | None = None
    # A re-run is reusing this node's previous output: no model call follows.
    replayed: bool = False


class NodeTokenEvent(BaseModel):
    """A piece of text a node's model just generated — token-level
    streaming, from LangGraph's `messages` stream mode. Concatenating a
    node's tokens (since its latest node_start) gives its output so far;
    node_complete then carries the authoritative full output."""

    node_id: str
    text: str


class NodeCompleteEvent(BaseModel):
    """One graph node just finished. Synthetic/internal nodes (the
    multi-root fan-out node, loop increment/failed nodes) are filtered out
    before reaching the client — this only ever describes a real
    pipeline-defined node, the same NodeOutputDTO shape AskResponse uses."""

    node: NodeOutputDTO


class LoopIterationEvent(BaseModel):
    """A loop's increment node fired — the loop is about to run another
    iteration (or has just exhausted max_iterations, in which case a
    node_complete or error event for the loop's exit/fail path follows)."""

    loop_id: str
    iteration: int


class StreamDoneEvent(BaseModel):
    """The pipeline finished successfully. Same information AskResponse
    carries — included in full (not just a delta) so a client that only
    cares about the final result doesn't need to have accumulated every
    node_complete event along the way."""

    pipeline_name: str
    output_node: str
    final_answer: str
    node_outputs: dict[str, NodeOutputDTO]
    loop_iterations: dict[str, int] = {}
    remembered: dict[str, str] = {}  # see AskResponse.remembered


# ---------------------------------------------------------------------------
# Pipeline listing / introspection response models
# ---------------------------------------------------------------------------


class PipelineSummary(BaseModel):
    name: str
    description: str
    filename: str


class HealthResponse(BaseModel):
    status: str
    pipelines_dir: str
    default_pipeline_name: str
    available_pipelines: list[PipelineSummary]
    # Whether saving/deleting pipelines and presets is actually allowed —
    # clients show pipelines read-only when this is false.
    editing_enabled: bool = False
    # Set when editing was requested (PIPELINE_EDITING_ENABLED) but the
    # server refuses it anyway, and why — see Settings.editing_block_reason.
    editing_disabled_reason: str | None = None


class PipelinesListResponse(BaseModel):
    pipelines: list[PipelineSummary]


class PipelineNodeInfo(BaseModel):
    id: str
    type: str
    depends_on: list[str]
    model: str  # "provider:model" identity string


class PipelineBranchRouteInfo(BaseModel):
    to: str | list[str]  # as written: one node, or several started together
    when: str | None  # None for the branch's default route
    default: bool


class PipelineBranchInfo(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    from_: str = Field(alias="from")  # "from" is a reserved word in Python
    routes: list[PipelineBranchRouteInfo]


class PipelineLoopInfo(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    from_: str = Field(alias="from")
    back_to: str
    exit_to: str
    max_iterations: int
    on_max_iterations: Literal["proceed", "fail"]


class PipelineDetailResponse(BaseModel):
    name: str
    description: str
    output_node_candidates: list[str]
    nodes: list[PipelineNodeInfo]
    branches: list[PipelineBranchInfo]
    loops: list[PipelineLoopInfo]


# ---------------------------------------------------------------------------
# Pipeline editing — full definitions, validation, saving, presets, models
# ---------------------------------------------------------------------------
#
# Definitions and presets travel as plain JSON objects in exactly the shape
# of the pipeline YAML (aliases applied, e.g. "from"; unset optional fields
# omitted). They are typed `dict[str, Any]` here deliberately: the server
# validates them itself through the same PipelineDefinition model the YAML
# loader uses, so that a failure produces this API's own ErrorResponse —
# naming the offending node — rather than FastAPI's generic 422.


class ModelInfo(BaseModel):
    name: str
    size_bytes: int | None = None
    parameter_size: str | None = None
    quantization: str | None = None
    family: str | None = None


class ProviderModels(BaseModel):
    provider: str
    reachable: bool
    error: str | None = None
    models: list[ModelInfo]


class ModelLimitsResponse(BaseModel):
    """Limits of one installed Ollama model, for editor hints."""

    name: str
    context_length: int | None = None
    parameter_size: str | None = None
    quantization: str | None = None
    family: str | None = None


class ModelsResponse(BaseModel):
    """What an editor may select. Anything not listed is rejected on save."""

    providers: list[ProviderModels]


class PipelineDefinitionResponse(BaseModel):
    definition: dict[str, Any]
    # Content hash of the file — send it back as `base_revision` when saving.
    revision: str
    # True when the file contains YAML comments, which saving from an editor
    # rewrites the file without.
    has_comments: bool


class PreviewPromptRequest(BaseModel):
    """What to render: a node of `definition` (which needn't be saved),
    given a message, the conversation so far and other nodes' outputs."""

    definition: dict[str, object]
    node_id: str
    prompt: str = ""  # empty: a placeholder stands in for the message
    history: list[ConversationTurn] = []
    outputs: dict[str, str] = {}


class PreviewPromptResponse(BaseModel):
    prompt: str
    system: str | None = None
    # The node's inputs with no output given — placeholders in `prompt`.
    missing: list[str] = []


class VariantRequest(BaseModel):
    """The pipeline with other models for some nodes: node id -> the model
    block to use instead (the node's whole model block, validated with the
    rest of the variant's definition)."""

    label: str = Field(min_length=1, max_length=40)
    models: dict[str, dict[str, object]] = Field(min_length=1)


class RunTestsRequest(BaseModel):
    """Runs a definition's test cases (it needn't be saved). `cases` picks
    some by name (default: all); `inputs` adds one-off messages, run like
    cases without expectations; each variant runs every case too, next to
    the definition as it is ("current")."""

    definition: dict[str, object]
    cases: list[str] | None = None
    inputs: list[str] = Field(default_factory=list[str], max_length=5)
    variants: list[VariantRequest] = Field(default_factory=list[VariantRequest], max_length=3)


class ExpectationResult(BaseModel):
    kind: Literal["contains", "not_contains", "check", "judge"]
    expected: str
    passed: bool
    # The judge's reply, or why a check couldn't be evaluated.
    detail: str | None = None


class CaseStart(BaseModel):
    case: str
    variant: str


class CaseResult(BaseModel):
    case: str
    variant: str
    # Null when the case has no expectations — it only shows the answer.
    passed: bool | None
    answer: str | None = None
    output_node: str | None = None
    # Set when the run itself failed (passed is then false).
    error: str | None = None
    expectations: list[ExpectationResult] = []
    # The pipeline run's time (not the judge's) and tokens.
    duration_ms: float
    prompt_tokens: int = 0
    completion_tokens: int = 0


class VariantSummary(BaseModel):
    variant: str
    passed: int
    failed: int
    errors: int
    unchecked: int
    duration_ms: float
    prompt_tokens: int
    completion_tokens: int


class RunTestsDone(BaseModel):
    summaries: list[VariantSummary]


class ValidatePipelineRequest(BaseModel):
    """Exactly one of `definition` or `yaml`."""

    definition: dict[str, Any] | None = None
    yaml: str | None = None


class ModelIssue(BaseModel):
    node_id: str | None
    message: str


class ValidatePipelineResponse(BaseModel):
    """The definition is structurally valid. `yaml` is the canonical file
    text a save would write — also what clients export. `model_issues` are
    models a save would currently reject (not installed / not allowlisted);
    reported rather than raised so an editor can show them as warnings."""

    definition: dict[str, Any]
    yaml: str
    model_issues: list[ModelIssue] = []
    # Settings beyond what a model supports (e.g. num_ctx above its maximum
    # context). Advisory only — a save is not blocked by these.
    warnings: list[ModelIssue] = []


class SavePipelineRequest(BaseModel):
    definition: dict[str, Any]
    # The revision the edit was based on; null to create a new pipeline.
    base_revision: str | None = None


class SavePipelineResponse(BaseModel):
    definition: dict[str, Any]
    revision: str
    # Saving over an existing file keeps its comments and layout. False only
    # in the rare case the file had to be rewritten in canonical form.
    comments_preserved: bool = True


class PresetsListResponse(BaseModel):
    presets: list[dict[str, Any]]


class PresetResponse(BaseModel):
    preset: dict[str, Any]
    revision: str


class SavePresetRequest(BaseModel):
    preset: dict[str, Any]


class DeletedResponse(BaseModel):
    """What was deleted, and where the file went — deletions are
    recoverable by moving the file back from the `.deleted/` folder."""

    name: str
    recoverable_as: str


# ---------------------------------------------------------------------------
# Error response contract
# ---------------------------------------------------------------------------


class ErrorCode(StrEnum):
    """What went wrong, for clients to act on. `status` alone can't tell
    apart failures that share one — a 409 is a pipeline changed since it
    was loaded, a taken name, or the protected default pipeline. Set where
    the error is raised, and always sent with the same status
    (api_error.STATUS_BY_CODE). Codes may be added over time, so a client
    should handle a code it doesn't know by its `status`."""

    # -- any endpoint
    REQUEST_INVALID = "REQUEST_INVALID"  # malformed or contradictory request; see `validations`
    UNAUTHENTICATED = "UNAUTHENTICATED"  # missing or unknown API key
    RATE_LIMITED = "RATE_LIMITED"  # retry after the `Retry-After` header
    INTERNAL_ERROR = "INTERNAL_ERROR"  # a server bug; quote `exceptionUID` when reporting it
    # -- pipelines, presets and models
    NAME_INVALID = "NAME_INVALID"  # not usable as a file name
    PIPELINE_NOT_FOUND = "PIPELINE_NOT_FOUND"
    PRESET_NOT_FOUND = "PRESET_NOT_FOUND"
    MODEL_NOT_FOUND = "MODEL_NOT_FOUND"  # Ollama model not installed, or Ollama unreachable
    DEFINITION_INVALID = "DEFINITION_INVALID"  # `details.node_id` names the node at fault, if one
    MODEL_NOT_ALLOWED = "MODEL_NOT_ALLOWED"  # `details.node_id` names the node, if one
    EDITING_DISABLED = "EDITING_DISABLED"  # writes are off on this server; `message` says why
    PIPELINE_EXISTS = "PIPELINE_EXISTS"  # creating a pipeline whose name is taken
    REVISION_CONFLICT = "REVISION_CONFLICT"  # changed or deleted since loaded: reload first
    PIPELINE_PROTECTED = "PIPELINE_PROTECTED"  # the server's default pipeline can't be deleted
    # -- runs, prompt previews and test runs
    INPUT_INVALID = "INPUT_INVALID"  # empty prompt, or a chat not ending with the user's message
    INPUT_TOO_LARGE = "INPUT_TOO_LARGE"  # prompt, history or re-run outputs over the limits
    NODE_NOT_FOUND = "NODE_NOT_FOUND"  # `rerun.from_node` or a preview's `node_id`
    TEST_CASE_NOT_FOUND = "TEST_CASE_NOT_FOUND"
    TEMPLATE_RENDER_FAILED = "TEMPLATE_RENDER_FAILED"
    PIPELINE_RUN_FAILED = "PIPELINE_RUN_FAILED"  # `details.node_id` or `details.loop_id` if known
    REQUEST_CANCELLED = "REQUEST_CANCELLED"  # the client disconnected; nobody receives this


class ValidationIssue(BaseModel):
    """One field-level problem, used only when `validations` is non-empty
    (request body schema validation failures)."""

    field: str
    message: str
    type: str


class ErrorResponse(BaseModel):
    """The one shape every error response takes, regardless of status code
    or where it was raised (an endpoint, a Depends() dependency, or FastAPI's
    own automatic request validation) — wired up via custom exception
    handlers in error_handling.py so this is constructed for every error
    path, not just a subset of them."""

    timestamp: datetime
    status: int
    error: str  # HTTP reason phrase, e.g. "Not Found", "Too Many Requests"
    code: ErrorCode  # which failure this is — what clients branch on
    message: str  # human-readable detail — what used to be the bare "detail" string
    request: str  # "<METHOD> <path>", e.g. "POST /ask"
    exceptionUID: str  # ties this error to server log lines carrying the same id
    details: dict[str, object] = {}  # extra structured context, varies by error type
    validations: list[ValidationIssue] = []  # populated only for 422 schema validation errors
