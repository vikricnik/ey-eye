import logging
import re
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from http import HTTPStatus
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from langgraph.graph.state import CompiledStateGraph

from llm_pipeline.models import (
    AskRequest,
    AskResponse,
    ConversationTurn,
    ErrorResponse,
    HealthResponse,
    NodeOutputDTO,
    PipelineBranchInfo,
    PipelineDetailResponse,
    PipelineLoopInfo,
    PipelineNodeInfo,
    PipelinesListResponse,
    PipelineState,
    ValidationIssue,
)
from llm_pipeline.pipeline_config import (
    PipelineDefinition,
    load_pipeline_definition,
    list_available_pipelines,
)
from llm_pipeline.dag_builder import build_graph
from llm_pipeline.history import build_contextual_input
from llm_pipeline.errors import PipelineExecutionError, PipelineNotFoundError
from llm_pipeline.settings import settings
from llm_pipeline.auth import require_api_key
from llm_pipeline.rate_limit import enforce_rate_limit
from llm_pipeline.logging_context import configure_logging, request_id_middleware, get_request_id

configure_logging()
logger: logging.Logger = logging.getLogger("llm_pipeline")


def _validate_pipelines_at_startup() -> None:
    """Cheap, schema-only re-validation of every pipelines/*.yaml file at
    startup — same checks CI should run. A broken pipeline is then visible
    in server logs immediately, not just the first time a client requests
    it. Deliberately does NOT call any real model (no cost/side effects for
    cloud providers) — this only re-parses and re-validates the YAML."""
    if not settings.validate_pipelines_on_startup:
        return

    if not settings.pipelines_path.is_dir():
        logger.warning(f"pipelines_dir '{settings.pipelines_path}' does not exist")
        return

    all_files = sorted(settings.pipelines_path.glob("*.yaml"))
    failures: list[str] = []
    for yaml_path in all_files:
        try:
            load_pipeline_definition(yaml_path)
        except Exception as e:
            failures.append(f"{yaml_path.name}: {e}")

    valid_count = len(all_files) - len(failures)
    logger.info(f"startup pipeline validation: {valid_count}/{len(all_files)} valid")
    for failure in failures:
        logger.error(f"startup pipeline validation FAILED for {failure}")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    _validate_pipelines_at_startup()
    yield


app: FastAPI = FastAPI(title="LLM Pipeline", version="3.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.middleware("http")(request_id_middleware)


def _reason_phrase(status_code: int) -> str:
    try:
        return HTTPStatus(status_code).phrase
    except ValueError:
        return "Error"


def _build_error_response(
    request: Request,
    status_code: int,
    message: str,
    details: dict[str, object] | None = None,
    validations: list[ValidationIssue] | None = None,
) -> ErrorResponse:
    """The one place every error field gets populated, so all three handlers
    below (HTTPException, RequestValidationError, and the catch-all for
    anything else) produce byte-for-byte the same shape."""
    return ErrorResponse(
        timestamp=datetime.now(timezone.utc),
        status=status_code,
        error=_reason_phrase(status_code),
        message=message,
        request=f"{request.method} {request.url.path}",
        exceptionUID=get_request_id(),
        details=details or {},
        validations=validations or [],
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    """Every HTTPException raised anywhere (endpoints, or Depends()
    dependencies like require_api_key/enforce_rate_limit) is caught here
    exactly once. Forwards exc.headers so the rate limiter's `Retry-After`
    header still reaches the client, and mirrors it into `details` too
    since that's the one piece of already-structured extra data a plain
    HTTPException carries."""
    details: dict[str, object] = {}
    if exc.headers and "Retry-After" in exc.headers:
        details["retry_after_seconds"] = exc.headers["Retry-After"]

    body = _build_error_response(request, exc.status_code, str(exc.detail), details=details)
    return JSONResponse(
        status_code=exc.status_code,
        content=body.model_dump(mode="json"),  # mode="json": datetime -> ISO string
        headers=exc.headers,
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """FastAPI's automatic 422 (e.g. a malformed AskRequest body) normally
    returns Pydantic's own nested error-list shape. Mapped into the same
    ErrorResponse contract instead — each individual field problem becomes
    one ValidationIssue in `validations`, rather than being flattened away."""
    validations = [
        ValidationIssue(
            field=".".join(str(loc) for loc in e["loc"]),
            message=e["msg"],
            type=e["type"],
        )
        for e in exc.errors()
    ]
    body = _build_error_response(
        request, 422, "Request validation failed", validations=validations
    )
    return JSONResponse(status_code=422, content=body.model_dump(mode="json"))


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catches anything not already handled above — a genuine bug slipping
    past the error handling this codebase explicitly anticipates. Without
    this, an unexpected exception would fall through to FastAPI's default
    handler and NOT match the ErrorResponse contract; with it, every
    possible error path — anticipated or not — returns the same shape."""
    logger.exception("Unhandled exception")
    body = _build_error_response(request, 500, "Internal server error")
    return JSONResponse(status_code=500, content=body.model_dump(mode="json"))


# Documents the error shape in OpenAPI for every status code an endpoint can
# actually raise — purely descriptive (the handlers above already enforce
# the shape at runtime regardless), but keeps generated API docs accurate.
_ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    400: {"model": ErrorResponse, "description": "Invalid input"},
    401: {"model": ErrorResponse, "description": "Missing or invalid API key"},
    404: {"model": ErrorResponse, "description": "Pipeline not found"},
    422: {"model": ErrorResponse, "description": "Request body failed validation"},
    429: {"model": ErrorResponse, "description": "Rate limit exceeded"},
    502: {"model": ErrorResponse, "description": "Unexpected pipeline error"},
    503: {"model": ErrorResponse, "description": "Pipeline tier fully failed"},
    500: {"model": ErrorResponse, "description": "Unhandled server error"},
}

# Only safe filename characters — pipeline_name comes straight from client
# input and is used to build a filesystem path, so this closes off any
# path-traversal attempt (e.g. "../../etc/passwd") before it reaches disk.
_SAFE_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")

# Cache of (definition, compiled_graph) per pipeline name. Stateless by design:
# every worker process independently loads the same YAML files from the same
# disk on first request for a given name — there's no shared mutable "active
# pipeline" to keep in sync across processes (see README for why that matters
# under multiple uvicorn workers).
_pipeline_cache: dict[str, tuple[PipelineDefinition, CompiledStateGraph]] = {}


def get_pipeline(name: str) -> tuple[PipelineDefinition, CompiledStateGraph]:
    if not _SAFE_NAME_PATTERN.match(name):
        raise PipelineNotFoundError(name)

    if name in _pipeline_cache:
        return _pipeline_cache[name]

    yaml_path = settings.pipelines_path / f"{name}.yaml"
    if not yaml_path.is_file():
        raise PipelineNotFoundError(name)

    definition = load_pipeline_definition(yaml_path)
    graph = build_graph(definition)
    _pipeline_cache[name] = (definition, graph)
    return definition, graph


def _validate_prompt_and_history(req: AskRequest) -> None:
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt cannot be empty")

    if len(req.prompt) > settings.max_prompt_length:
        raise HTTPException(
            status_code=400,
            detail=(
                f"prompt exceeds max_prompt_length ({len(req.prompt)} > "
                f"{settings.max_prompt_length} characters)"
            ),
        )

    for i, turn in enumerate(req.history):
        if len(turn.prompt) > settings.max_history_turn_length:
            raise HTTPException(
                status_code=400,
                detail=f"history[{i}].prompt exceeds max_history_turn_length",
            )
        if len(turn.final_answer) > settings.max_history_turn_length:
            raise HTTPException(
                status_code=400,
                detail=f"history[{i}].final_answer exceeds max_history_turn_length",
            )


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    # Deliberately NOT behind auth/rate-limit — load balancers and
    # orchestrators typically probe this without credentials.
    return HealthResponse(
        status="ok",
        pipelines_dir=str(settings.pipelines_path),
        default_pipeline_name=settings.default_pipeline_name,
        available_pipelines=list_available_pipelines(settings.pipelines_path),
    )


@app.get(
    "/pipelines",
    response_model=PipelinesListResponse,
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    responses={k: _ERROR_RESPONSES[k] for k in (401, 422, 429)},
)
async def list_pipelines() -> PipelinesListResponse:
    return PipelinesListResponse(pipelines=list_available_pipelines(settings.pipelines_path))


@app.get(
    "/pipelines/{name}",
    response_model=PipelineDetailResponse,
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    responses={k: _ERROR_RESPONSES[k] for k in (401, 404, 422, 429)},
)
async def get_pipeline_definition(name: str) -> PipelineDetailResponse:
    """Returns the full parsed definition — nodes, edges, models — so a
    client can render the DAG shape (e.g. a picker showing what a pipeline
    actually does) before running it."""
    try:
        definition, _ = get_pipeline(name)
    except PipelineNotFoundError:
        raise HTTPException(status_code=404, detail=f"No pipeline named '{name}'")

    return PipelineDetailResponse(
        name=definition.name,
        description=definition.description,
        output_node_candidates=definition.output_node_candidates,
        nodes=[
            PipelineNodeInfo(
                id=n.id,
                type=n.type,
                depends_on=n.depends_on,
                model=f"{n.model.provider.value}:{n.model.model}",
            )
            for n in definition.nodes
        ],
        branches=[
            PipelineBranchInfo(id=b.id, from_=b.from_, routes=[r.to for r in b.routes])
            for b in definition.branches
        ],
        loops=[
            PipelineLoopInfo(
                id=l.id,
                from_=l.from_,
                back_to=l.back_to,
                exit_to=l.exit_to,
                max_iterations=l.max_iterations,
            )
            for l in definition.loops
        ],
    )


@app.post(
    "/ask",
    response_model=AskResponse,
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    responses={k: _ERROR_RESPONSES[k] for k in (400, 401, 404, 422, 429, 502, 503)},
)
async def ask(req: AskRequest) -> AskResponse:
    _validate_prompt_and_history(req)

    try:
        definition, graph = get_pipeline(req.pipeline_name)
    except PipelineNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    trimmed_history: list[ConversationTurn] = (
        req.history[-definition.execution.max_history_turns :]
        if definition.execution.max_history_turns > 0
        else []
    )
    contextual_input = build_contextual_input(req.prompt, trimmed_history)

    initial_state: PipelineState = {
        "input": req.prompt,
        "contextual_input": contextual_input,
        "node_outputs": {},
        "loop_counts": {},
    }

    try:
        final_state: PipelineState = await graph.ainvoke(initial_state)
    except PipelineExecutionError as e:
        logger.exception(f"Pipeline '{req.pipeline_name}' run failed")
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.exception(f"Pipeline '{req.pipeline_name}' run failed unexpectedly")
        raise HTTPException(status_code=502, detail=f"Pipeline error: {e}")

    node_outputs = final_state["node_outputs"]

    # output_node is one or more CANDIDATES, not a single fixed id — once a
    # branch means only one of several possible "final" nodes actually runs
    # per request, the server picks whichever candidate is actually present.
    resolved_output_node: str | None = None
    for candidate in definition.output_node_candidates:
        if candidate in node_outputs:
            resolved_output_node = candidate
            break

    if resolved_output_node is None:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Pipeline completed but none of its output_node candidates "
                f"({', '.join(definition.output_node_candidates)}) produced a result"
            ),
        )

    return AskResponse(
        pipeline_name=definition.name,
        output_node=resolved_output_node,
        final_answer=node_outputs[resolved_output_node]["output"],
        node_outputs={
            node_id: NodeOutputDTO(**result) for node_id, result in node_outputs.items()
        },
        loop_iterations=final_state.get("loop_counts", {}),
    )
