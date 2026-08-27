from fastapi import APIRouter, Depends, HTTPException

from llm_pipeline.api_schemas import (
    HealthResponse,
    PipelineBranchInfo,
    PipelineBranchRouteInfo,
    PipelineDetailResponse,
    PipelineLoopInfo,
    PipelineNodeInfo,
    PipelinesListResponse,
)
from llm_pipeline.auth import require_api_key
from llm_pipeline.error_handling import ERROR_RESPONSES
from llm_pipeline.errors import PipelineNotFoundError
from llm_pipeline.pipeline_config import list_available_pipelines
from llm_pipeline.pipeline_loader import PipelineCache, get_pipeline_cache
from llm_pipeline.rate_limit import enforce_rate_limit
from llm_pipeline.settings import settings

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    # Deliberately NOT behind auth/rate-limit — load balancers and
    # orchestrators typically probe this without credentials.
    return HealthResponse(
        status="ok",
        pipelines_dir=str(settings.pipelines_path),
        default_pipeline_name=settings.default_pipeline_name,
        available_pipelines=list_available_pipelines(settings.pipelines_path),
    )


@router.get(
    "/pipelines",
    response_model=PipelinesListResponse,
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    responses={k: ERROR_RESPONSES[k] for k in (401, 422, 429)},
)
async def list_pipelines() -> PipelinesListResponse:
    return PipelinesListResponse(pipelines=list_available_pipelines(settings.pipelines_path))


@router.get(
    "/pipelines/{name}",
    response_model=PipelineDetailResponse,
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    responses={k: ERROR_RESPONSES[k] for k in (401, 404, 422, 429)},
)
async def get_pipeline_definition(
    name: str, cache: PipelineCache = Depends(get_pipeline_cache)
) -> PipelineDetailResponse:
    """Returns the full parsed definition — nodes, edges, models — so a
    client can render the DAG shape (e.g. a picker showing what a pipeline
    actually does) before running it."""
    try:
        definition, _ = cache.get(name)
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
                model=(
                    f"{n.model.provider.value}:{n.model.model}"
                    if n.model is not None
                    else "(no model — non-llm_call node type)"
                ),
            )
            for n in definition.nodes
        ],
        branches=[
            # model_validate() with a plain dict, not keyword arguments:
            # `from` is a reserved word (can't be a Python kwarg at all), and
            # pydantic's alias-based synthesized __init__ signature — which
            # pyright reads literally — only recognizes the alias "from" as
            # a keyword name, not the populate_by_name-permitted "from_".
            # A dict keyed by the alias sidesteps that mismatch entirely.
            PipelineBranchInfo.model_validate(
                {
                    "id": b.id,
                    "from": b.from_,
                    "routes": [
                        PipelineBranchRouteInfo(to=r.to, when=r.when, default=r.default)
                        for r in b.routes
                    ],
                }
            )
            for b in definition.branches
        ],
        loops=[
            PipelineLoopInfo.model_validate(
                {
                    "id": l.id,
                    "from": l.from_,
                    "back_to": l.back_to,
                    "exit_to": l.exit_to,
                    "max_iterations": l.max_iterations,
                    "on_max_iterations": l.on_max_iterations,
                }
            )
            for l in definition.loops
        ],
    )
