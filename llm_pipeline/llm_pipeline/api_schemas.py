"""
The public API contract — every model that actually crosses the wire:
request bodies, response bodies, error bodies. Anything here is effectively
a promise to API consumers (the CLI, the web client, anyone else); changing
a field name or type here is a breaking change in a way that changing
state.py's internal PipelineState shape is not.
"""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


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


# ---------------------------------------------------------------------------
# Error response contract
# ---------------------------------------------------------------------------

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
    message: str  # human-readable detail — what used to be the bare "detail" string
    request: str  # "<METHOD> <path>", e.g. "POST /ask"
    exceptionUID: str  # ties this error to server log lines carrying the same id
    details: dict[str, object] = {}  # extra structured context, varies by error type
    validations: list[ValidationIssue] = []  # populated only for 422 schema validation errors
