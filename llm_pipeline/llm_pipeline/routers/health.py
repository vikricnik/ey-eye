"""
GET /health (open — is the server up?), GET /server-info (what a client
needs to start) and GET /pipelines — the pipeline listing. Reading one
pipeline (GET /pipelines/{name}) lives with saving it, in editing.py: both
speak the same representation.
"""

from fastapi import APIRouter, Depends

from llm_pipeline.api_schemas import (
    HealthResponse,
    PipelinesListResponse,
    PipelineSummary,
    ServerInfoResponse,
)
from llm_pipeline.auth import require_api_key
from llm_pipeline.error_handling import ERROR_RESPONSES
from llm_pipeline.pipeline_config import list_available_pipelines
from llm_pipeline.rate_limit import enforce_rate_limit
from llm_pipeline.settings import settings

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    # Deliberately NOT behind auth/rate-limit — load balancers and
    # orchestrators typically probe this without credentials. So it tells
    # them only that the server is up: anything else is /server-info's.
    return HealthResponse()


@router.get(
    "/server-info",
    response_model=ServerInfoResponse,
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    responses={k: ERROR_RESPONSES[k] for k in (401, 429)},
)
async def server_info() -> ServerInfoResponse:
    return ServerInfoResponse(
        default_pipeline_name=settings.default_pipeline_name,
        editing_enabled=settings.editing_active,
        editing_disabled_reason=settings.editing_block_reason,
    )


@router.get(
    "/pipelines",
    response_model=PipelinesListResponse,
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    responses={k: ERROR_RESPONSES[k] for k in (401, 422, 429)},
)
async def list_pipelines() -> PipelinesListResponse:
    """The loadable pipelines — a file that fails validation is left out."""
    return PipelinesListResponse(
        pipelines=[
            PipelineSummary(name=p.name, description=p.description, filename=p.filename)
            for p in list_available_pipelines(settings.pipelines_path)
        ]
    )
