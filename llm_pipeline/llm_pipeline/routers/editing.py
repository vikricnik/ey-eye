"""
Endpoints for editor clients (the web builder and the CLI's edit
commands): the models they may select, full pipeline definitions,
validation/import/export, saving, and node presets.

Reads are available whenever the client is authenticated. Every write is
additionally gated by `pipeline_editing_enabled` (off by default) — see
require_editing_enabled. Validation, allowlisting and file handling all
live in pipeline_store.py / model_catalog.py; these handlers only
translate between HTTP and those.
"""

from collections.abc import AsyncGenerator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from llm_pipeline.api_error import ApiError
from llm_pipeline.api_schemas import (
    DeletedResponse,
    ErrorCode,
    ModelInfo,
    ModelIssue,
    ModelLimitsResponse,
    ModelsResponse,
    PipelineDefinitionResponse,
    PresetResponse,
    PresetsListResponse,
    PreviewPromptRequest,
    PreviewPromptResponse,
    ProviderModels,
    RunTestsRequest,
    SavePipelineRequest,
    SavePipelineResponse,
    SavePresetRequest,
    ValidatePipelineRequest,
    ValidatePipelineResponse,
)
from llm_pipeline.auth import require_api_key
from llm_pipeline.dag_builder import build_graph
from llm_pipeline.disconnects import until_disconnected
from llm_pipeline.error_handling import ERROR_RESPONSES
from llm_pipeline.errors import PipelineNotFoundError
from llm_pipeline.evaluation import Variant, make_judge, run_tests
from llm_pipeline.pipeline_config import EvalCase, PipelineDefinition
from llm_pipeline.pipeline_loader import PipelineCache, get_pipeline_cache
from llm_pipeline.pipeline_store import (
    PipelineStore,
    definition_to_json,
    definition_to_yaml,
    effective_model_uses,
    get_pipeline_store,
    parse_definition,
    parse_definition_yaml,
)
from llm_pipeline.preview import preview_prompt
from llm_pipeline.rate_limit import enforce_rate_limit
from llm_pipeline.routers.ask import sse_event
from llm_pipeline.settings import settings

router = APIRouter(dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)])


async def require_editing_enabled() -> None:
    if not settings.pipeline_editing_enabled:
        raise ApiError(
            ErrorCode.EDITING_DISABLED,
            "Pipeline editing is disabled on this server — set "
            "PIPELINE_EDITING_ENABLED=true to allow saving from clients",
        )
    reason = settings.editing_block_reason
    if reason is not None:
        raise ApiError(ErrorCode.EDITING_DISABLED, f"Pipeline {reason}")


@router.get(
    "/models",
    response_model=ModelsResponse,
    responses={k: ERROR_RESPONSES[k] for k in (401, 429)},
)
async def list_models(
    refresh: bool = False, store: PipelineStore = Depends(get_pipeline_store)
) -> ModelsResponse:
    """Models an editor may pick: installed Ollama models plus the cloud
    models in EDITOR_CLOUD_MODELS. `refresh=true` bypasses the short cache."""
    catalogs = await store.catalog.providers(refresh=refresh)
    return ModelsResponse(
        providers=[
            ProviderModels(
                provider=c.provider,
                reachable=c.reachable,
                error=c.error,
                models=[
                    ModelInfo(
                        name=m.name,
                        size_bytes=m.size_bytes,
                        parameter_size=m.parameter_size,
                        quantization=m.quantization,
                        family=m.family,
                    )
                    for m in c.models
                ],
            )
            for c in catalogs
        ]
    )


@router.get(
    "/models/ollama/{name:path}",
    response_model=ModelLimitsResponse,
    responses={k: ERROR_RESPONSES[k] for k in (401, 404, 429)},
)
async def get_ollama_model_limits(
    name: str, store: PipelineStore = Depends(get_pipeline_store)
) -> ModelLimitsResponse:
    """Max context length, size and quantization of an installed Ollama
    model (names may contain '/' and ':')."""
    found = await store.catalog.limits(name)
    if found is None:
        raise ApiError(
            ErrorCode.MODEL_NOT_FOUND,
            f"No details for Ollama model '{name}' (not installed, or Ollama unreachable)",
        )
    return ModelLimitsResponse(
        name=found.name,
        context_length=found.context_length,
        parameter_size=found.parameter_size,
        quantization=found.quantization,
        family=found.family,
    )


@router.get(
    "/pipelines/{name}/definition",
    response_model=PipelineDefinitionResponse,
    responses={k: ERROR_RESPONSES[k] for k in (401, 404, 422, 429)},
)
async def get_pipeline_full_definition(
    name: str, store: PipelineStore = Depends(get_pipeline_store)
) -> PipelineDefinitionResponse:
    """The complete definition — prompts, options, layout — plus the
    revision to send back when saving."""
    try:
        stored = store.read_pipeline(name)
    except PipelineNotFoundError:
        raise ApiError(ErrorCode.PIPELINE_NOT_FOUND, f"No pipeline named '{name}'") from None
    return PipelineDefinitionResponse(
        definition=definition_to_json(stored.definition),
        revision=stored.revision,
        has_comments=stored.has_comments,
    )


@router.post(
    "/pipelines/validate",
    response_model=ValidatePipelineResponse,
    responses={k: ERROR_RESPONSES[k] for k in (401, 422, 429)},
)
async def validate_pipeline(
    req: ValidatePipelineRequest, store: PipelineStore = Depends(get_pipeline_store)
) -> ValidatePipelineResponse:
    """Validates without saving. Accepts a JSON definition or YAML text and
    returns both forms — so the same call serves live validation, import
    (YAML in) and export (canonical YAML out). Never writes anything, so
    it doesn't need editing to be enabled."""
    if (req.definition is None) == (req.yaml is None):
        raise ApiError(ErrorCode.REQUEST_INVALID, "send exactly one of 'definition' or 'yaml'")
    definition = (
        parse_definition(req.definition)
        if req.definition is not None
        else parse_definition_yaml(req.yaml or "")
    )
    issues = await store.model_issues(definition.name, definition)
    warnings = await store.catalog.limit_warnings(effective_model_uses(definition))
    return ValidatePipelineResponse(
        definition=definition_to_json(definition),
        yaml=definition_to_yaml(definition),
        model_issues=[ModelIssue(node_id=i.node_id, message=str(i)) for i in issues],
        warnings=[ModelIssue(node_id=node_id, message=message) for node_id, message in warnings],
    )


@router.post(
    "/pipelines/preview",
    response_model=PreviewPromptResponse,
    # Renders templates a client sends: the same trust as saving them.
    dependencies=[Depends(require_editing_enabled)],
    responses={k: ERROR_RESPONSES[k] for k in (401, 403, 404, 422, 429)},
)
async def preview_node_prompt(req: PreviewPromptRequest) -> PreviewPromptResponse:
    """The prompt and system prompt a node would receive — see preview.py."""
    definition = parse_definition(req.definition)
    try:
        preview = await preview_prompt(
            definition, req.node_id, req.prompt, req.history, req.outputs
        )
    except KeyError as e:
        raise ApiError(ErrorCode.NODE_NOT_FOUND, f"no node '{req.node_id}'") from e
    except Exception as e:  # the sandbox's SecurityError, undefined variables, …
        raise ApiError(
            ErrorCode.TEMPLATE_RENDER_FAILED, f"the prompt can't be rendered: {e}"
        ) from e
    return PreviewPromptResponse(
        prompt=preview.prompt, system=preview.system, missing=preview.missing
    )


def _with_models(
    base: PipelineDefinition, models: dict[str, dict[str, object]]
) -> PipelineDefinition:
    """`base` with the given nodes' model blocks replaced — re-validated as
    a whole, like any client-submitted definition."""
    data = definition_to_json(base)
    nodes = {node["id"]: node for node in data["nodes"]}
    for node_id, model in models.items():
        if node_id not in nodes:
            raise ApiError(
                ErrorCode.NODE_NOT_FOUND, f"variant: no node '{node_id}' in '{base.name}'"
            )
        nodes[node_id]["model"] = model
    return parse_definition(data)


@router.post(
    "/pipelines/test",
    # Runs models and templates a client chose: the same trust as saving.
    dependencies=[Depends(require_editing_enabled)],
    responses={
        **{k: ERROR_RESPONSES[k] for k in (401, 403, 404, 422, 429)},
        200: {
            "content": {"text/event-stream": {}},
            "description": "case_start / case_result per case and variant, then tests_done",
        },
    },
)
async def run_pipeline_tests(
    req: RunTestsRequest,
    request: Request,
    store: PipelineStore = Depends(get_pipeline_store),
    cache: PipelineCache = Depends(get_pipeline_cache),
) -> StreamingResponse:
    """Runs a definition's test cases, and each variant's — see evaluation.py."""
    base = parse_definition(req.definition)
    cases = base.tests.cases
    if req.cases is not None:
        by_name = {case.name: case for case in cases}
        unknown = [name for name in req.cases if name not in by_name]
        if unknown:
            raise ApiError(ErrorCode.TEST_CASE_NOT_FOUND, f"no test case named '{unknown[0]}'")
        cases = [by_name[name] for name in req.cases]
    cases = cases + [
        EvalCase(name=f"message {i}", input=text)
        for i, text in enumerate((t for t in req.inputs if t.strip()), start=1)
    ]
    if not cases:
        raise ApiError(
            ErrorCode.REQUEST_INVALID,
            "no test cases to run — add some, or send a message to try",
        )
    labels = ["current", *(v.label for v in req.variants)]
    if len(set(labels)) != len(labels):
        raise ApiError(ErrorCode.REQUEST_INVALID, "each variant needs its own label")

    definitions = [base, *(_with_models(base, v.models) for v in req.variants)]
    for definition in definitions:
        issues = await store.model_issues(base.name, definition)
        if issues:
            raise issues[0]
    variants = [
        Variant(label, definition, build_graph(definition, cache.node_services))
        for label, definition in zip(labels, definitions, strict=True)
    ]
    judge = base.tests.judge
    judge_fn = make_judge(judge, base, cache.circuit_breaker) if judge else None

    async def events() -> AsyncGenerator[str, None]:
        async for event_type, data in run_tests(variants, cases, judge_fn):
            yield sse_event(event_type, data)

    return StreamingResponse(
        until_disconnected(request, events()),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.put(
    "/pipelines/{name}",
    response_model=SavePipelineResponse,
    dependencies=[Depends(require_editing_enabled)],
    responses={k: ERROR_RESPONSES[k] for k in (400, 401, 403, 409, 422, 429)},
)
async def save_pipeline(
    name: str, req: SavePipelineRequest, store: PipelineStore = Depends(get_pipeline_store)
) -> SavePipelineResponse:
    """Creates (`base_revision: null`) or updates (`base_revision` = the
    revision you loaded) pipelines/<name>.yaml. Runs are picked up
    immediately — the next /ask uses the saved version."""
    stored = await store.save_pipeline(name, req.definition, req.base_revision)
    return SavePipelineResponse(
        definition=definition_to_json(stored.definition),
        revision=stored.revision,
        comments_preserved=stored.comments_preserved,
    )


@router.delete(
    "/pipelines/{name}",
    response_model=DeletedResponse,
    dependencies=[Depends(require_editing_enabled)],
    responses={k: ERROR_RESPONSES[k] for k in (400, 401, 403, 404, 409, 429)},
)
async def delete_pipeline(
    name: str,
    revision: str | None = None,
    store: PipelineStore = Depends(get_pipeline_store),
) -> DeletedResponse:
    """Moves pipelines/<name>.yaml to pipelines/.deleted/ (recoverable).
    Pass `revision` to refuse if it changed since you loaded it. The
    server's default pipeline can't be deleted (409)."""
    try:
        moved = await store.delete_pipeline(name, revision)
    except PipelineNotFoundError:
        raise ApiError(ErrorCode.PIPELINE_NOT_FOUND, f"No pipeline named '{name}'") from None
    return DeletedResponse(name=name, recoverable_as=moved)


@router.get(
    "/presets",
    response_model=PresetsListResponse,
    responses={k: ERROR_RESPONSES[k] for k in (401, 429)},
)
async def list_presets(store: PipelineStore = Depends(get_pipeline_store)) -> PresetsListResponse:
    return PresetsListResponse(
        presets=[p.model_dump(mode="json", exclude_none=True) for p in store.list_presets()]
    )


@router.get(
    "/presets/{name}",
    response_model=PresetResponse,
    responses={k: ERROR_RESPONSES[k] for k in (401, 404, 429)},
)
async def get_preset(
    name: str, store: PipelineStore = Depends(get_pipeline_store)
) -> PresetResponse:
    try:
        stored = store.read_preset(name)
    except FileNotFoundError:
        raise ApiError(ErrorCode.PRESET_NOT_FOUND, f"No preset named '{name}'") from None
    return PresetResponse(
        preset=stored.preset.model_dump(mode="json", exclude_none=True), revision=stored.revision
    )


@router.put(
    "/presets/{name}",
    response_model=PresetResponse,
    dependencies=[Depends(require_editing_enabled)],
    responses={k: ERROR_RESPONSES[k] for k in (400, 401, 403, 422, 429)},
)
async def save_preset(
    name: str, req: SavePresetRequest, store: PipelineStore = Depends(get_pipeline_store)
) -> PresetResponse:
    stored = await store.save_preset(name, req.preset)
    return PresetResponse(
        preset=stored.preset.model_dump(mode="json", exclude_none=True), revision=stored.revision
    )


@router.delete(
    "/presets/{name}",
    response_model=DeletedResponse,
    dependencies=[Depends(require_editing_enabled)],
    responses={k: ERROR_RESPONSES[k] for k in (400, 401, 403, 404, 429)},
)
async def delete_preset(
    name: str, store: PipelineStore = Depends(get_pipeline_store)
) -> DeletedResponse:
    """Moves presets/<name>.yaml to presets/.deleted/ (recoverable)."""
    try:
        moved = await store.delete_preset(name)
    except FileNotFoundError:
        raise ApiError(ErrorCode.PRESET_NOT_FOUND, f"No preset named '{name}'") from None
    return DeletedResponse(name=name, recoverable_as=moved)
