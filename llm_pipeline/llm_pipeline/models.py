from datetime import datetime
from typing import Annotated, TypedDict
from pydantic import BaseModel, Field, ConfigDict


class ConversationTurn(BaseModel):
    """One prior exchange, sent by the client as conversation context."""

    prompt: str
    final_answer: str


class AskRequest(BaseModel):
    prompt: str
    # Pipeline selection is stateless and per-request rather than a server-side
    # "active pipeline" — every worker process loads the same YAML files from
    # the same disk independently; there's no shared mutable state to
    # disagree about across multiple uvicorn workers.
    pipeline_name: str
    history: list[ConversationTurn] = []


class NodeResult(TypedDict):
    node_id: str
    model_name: str  # provider:model identity, e.g. "ollama:qwen3-coder:30b"
    output: str
    duration_ms: float


def merge_node_outputs(a: dict[str, NodeResult], b: dict[str, NodeResult]) -> dict[str, NodeResult]:
    """Reducer for parallel nodes writing to the same state key: each node
    writes its own unique node_id key, so siblings completing in the same
    LangGraph superstep merge without colliding. Also correctly holds only
    the LATEST result for a node that runs multiple times in a loop, since
    a later write to the same key simply overwrites the earlier one."""
    merged = dict(a)
    merged.update(b)
    return merged


def merge_loop_counts(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    """Reducer for loop iteration counters — same merge-by-key shape as
    merge_node_outputs, just for the small int-valued loop_counts map."""
    merged = dict(a)
    merged.update(b)
    return merged


class PipelineState(TypedDict):
    input: str
    contextual_input: str  # input with conversation history folded in
    node_outputs: Annotated[dict[str, NodeResult], merge_node_outputs]
    loop_counts: Annotated[dict[str, int], merge_loop_counts]


class NodeOutputDTO(BaseModel):
    node_id: str
    model_name: str
    output: str
    duration_ms: float


class AskResponse(BaseModel):
    pipeline_name: str
    output_node: str  # whichever output_node candidate actually resolved
    final_answer: str
    node_outputs: dict[str, NodeOutputDTO]
    loop_iterations: dict[str, int] = {}


# ---------------------------------------------------------------------------
# Pipeline listing / introspection response models
#
# These replace what used to be loosely-typed `dict[str, object]` return
# values on /health, /pipelines, and /pipelines/{name} — giving FastAPI a
# real schema to validate against and document in its OpenAPI output,
# instead of "whatever shape the dict happened to have at the time."
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


class PipelinesListResponse(BaseModel):
    pipelines: list[PipelineSummary]


class PipelineNodeInfo(BaseModel):
    id: str
    type: str
    depends_on: list[str]
    model: str  # "provider:model" identity string


class PipelineBranchInfo(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    from_: str = Field(alias="from")  # "from" is a reserved word in Python
    routes: list[str]


class PipelineLoopInfo(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    from_: str = Field(alias="from")
    back_to: str
    exit_to: str
    max_iterations: int


class PipelineDetailResponse(BaseModel):
    name: str
    description: str
    output_node_candidates: list[str]
    nodes: list[PipelineNodeInfo]
    branches: list[PipelineBranchInfo]
    loops: list[PipelineLoopInfo]


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
    handlers in main.py so this is constructed for every error path, not
    just a subset of them."""

    timestamp: datetime
    status: int
    error: str  # HTTP reason phrase, e.g. "Not Found", "Too Many Requests"
    message: str  # human-readable detail — what used to be the bare "detail" string
    request: str  # "<METHOD> <path>", e.g. "POST /ask"
    exceptionUID: str  # ties this error to server log lines carrying the same id
    details: dict[str, object] = {}  # extra structured context, varies by error type
    validations: list[ValidationIssue] = []  # populated only for 422 schema validation errors
