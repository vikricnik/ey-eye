from fastapi import APIRouter, Depends, HTTPException

from llm_pipeline.api_schemas import (
    HealthResponse,
    PipelineBranchInfo,
    PipelineBranchRouteInfo,
    PipelineDetailResponse,
    PipelineLoopInfo,
    PipelineNodeInfo,
    PipelinesListResponse,
    PipelineSummary,
)
from llm_pipeline.auth import require_api_key
from llm_pipeline.error_handling import ERROR_RESPONSES
from llm_pipeline.errors import PipelineNotFoundError
from llm_pipeline.model_catalog import model_identity
from llm_pipeline.pipeline_config import NodeConfig, PipelineDefinition, list_available_pipelines
from llm_pipeline.pipeline_config.effective import effective_node
from llm_pipeline.pipeline_loader import PipelineCache, get_pipeline_cache
from llm_pipeline.rate_limit import enforce_rate_limit
from llm_pipeline.settings import settings

router = APIRouter()


def _model_label(definition: PipelineDefinition, node: NodeConfig) -> str:
    """ "provider:model" the node runs with, "(default)" when it inherits the
    pipeline's default model — the same label as the client's displayModel."""
    identity = model_identity(effective_node(definition, node).model)
    return identity if node.model is not None else f"{identity} (default)"


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
        raise HTTPException(status_code=404, detail=f"No pipeline named '{name}'") from None

    return PipelineDetailResponse(
        name=definition.name,
        description=definition.description,
        output_node_candidates=definition.output_node_candidates,
        nodes=[
            PipelineNodeInfo(
                id=n.id,
                type=n.type,
                depends_on=n.depends_on,
                model=_model_label(definition, n),
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
                    "id": loop.id,
                    "from": loop.from_,
                    "back_to": loop.back_to,
                    "exit_to": loop.exit_to,
                    "max_iterations": loop.max_iterations,
                    "on_max_iterations": loop.on_max_iterations,
                }
            )
            for loop in definition.loops
        ],
    )
