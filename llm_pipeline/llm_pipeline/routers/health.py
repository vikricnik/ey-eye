"""
GET /health and GET /pipelines — the pipeline listing. Reading one pipeline
(GET /pipelines/{name}) lives with saving it, in editing.py: both speak the
same representation.
"""

from fastapi import APIRouter, Depends

from llm_pipeline.api_schemas import (
    HealthResponse,
    PipelinesListResponse,
    PipelineSummary,
)
from llm_pipeline.auth import require_api_key
from llm_pipeline.error_handling import ERROR_RESPONSES
from llm_pipeline.pipeline_config import list_available_pipelines
from llm_pipeline.rate_limit import enforce_rate_limit
from llm_pipeline.settings import settings

router = APIRouter()


def _summaries() -> list[PipelineSummary]:
    """The loadable pipelines, in the wire shape listings return."""
    return [
        PipelineSummary(name=p.name, description=p.description, filename=p.filename)
        for p in list_available_pipelines(settings.pipelines_path)
    ]


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    # Deliberately NOT behind auth/rate-limit — load balancers and
    # orchestrators typically probe this without credentials.
    return HealthResponse(
        status="ok",
        pipelines_dir=str(settings.pipelines_path),
        default_pipeline_name=settings.default_pipeline_name,
        available_pipelines=_summaries(),
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
    return PipelinesListResponse(pipelines=_summaries())
