"""
App composition root: creates the FastAPI app, wires middleware, sets up
app.state.pipeline_cache (dependency-injected into routers via
pipeline_loader.get_pipeline_cache — see that module's docstring for why
this replaced a bare module-level global), registers exception handlers,
and includes the routers. No route logic or business logic lives here
directly — see routers/health.py, routers/discovery.py, routers/runs.py,
error_handling.py, pipeline_loader.py.
"""

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from llm_pipeline.logging_context import configure_logging, request_id_middleware
from llm_pipeline.settings import settings

# Before the imports below: libraries they load warn while loading (LangChain
# deprecations), and those lines must come out in the configured format too —
# with LOG_FORMAT=json, a text line would break the stream for log shippers.
configure_logging(settings.log_format)

from llm_pipeline.error_handling import register_exception_handlers
from llm_pipeline.model_catalog import ModelCatalog
from llm_pipeline.pipeline_config import load_pipeline_definition
from llm_pipeline.pipeline_loader import PipelineCache
from llm_pipeline.pipeline_store import PipelineStore
from llm_pipeline.routers import discovery, editing, health, metrics, openai_compat, runs

logger: logging.Logger = logging.getLogger("llm_pipeline")

# Every route of this API is under it, so a breaking change can arrive as
# /v2 beside it instead of breaking every client at once. Outside it: what
# is called at fixed paths (/health for load balancers, /metrics for
# Prometheus) and the OpenAI-compatible routes, under OpenAI's own
# /openai/v1.
API_V1 = "/v1"


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
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    _validate_pipelines_at_startup()
    # One catalog, shared: the store checks models against it, and nodes
    # ask it how much context their loaded Ollama model has.
    app.state.model_catalog = ModelCatalog(
        ollama_base_url=settings.ollama_base_url,
        cloud_models=settings.editor_cloud_models_list,
        ttl_seconds=settings.model_catalog_ttl_seconds,
    )
    # One PipelineCache per app instance, stored on app.state — this is
    # what makes it genuinely dependency-injected rather than a bare
    # module-level global: a different app instance (e.g. in a test) gets
    # its own independent cache and circuit-breaker state automatically,
    # with nothing to explicitly reset between runs beyond what that test
    # itself constructs.
    app.state.pipeline_cache = PipelineCache(
        pipelines_dir=settings.pipelines_path,
        failure_threshold=settings.circuit_breaker_failure_threshold,
        cooldown_seconds=settings.circuit_breaker_cooldown_seconds,
        context_probe=app.state.model_catalog.running_context,
    )
    # Same injection pattern for the editor's collaborators: the store
    # writes through the SAME cache the run endpoints read from, so a save
    # invalidates exactly the compiled graph that the next run would use.
    app.state.pipeline_store = PipelineStore(
        pipelines_dir=settings.pipelines_path,
        presets_dir=settings.presets_path,
        on_pipeline_changed=app.state.pipeline_cache.invalidate,
        catalog=app.state.model_catalog,
        default_pipeline_name=settings.default_pipeline_name,
    )
    if settings.editing_block_reason:
        logger.error(settings.editing_block_reason)
    elif settings.pipeline_editing_enabled:
        logger.info(
            f"pipeline editing ENABLED — clients may save to {settings.pipelines_path} "
            f"and {settings.presets_path}"
        )
    yield


def create_app() -> FastAPI:
    """Factory, not just a module-level `app = FastAPI(...)` — makes it
    possible to construct multiple independent app instances (each with
    their own PipelineCache on app.state) in the same process, e.g. one per
    test, without any risk of cross-instance state leakage."""
    app = FastAPI(
        title="LLM Pipeline",
        version="3.1.0",
        lifespan=lifespan,
        # One schema per model, as clients read it: definitions and presets
        # are documented as the models they are (see
        # api_schemas.PipelineDefinitionJson), in responses too.
        separate_input_output_schemas=False,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_methods=["*"],
        allow_headers=["*"],
        # A browser only lets page scripts read response headers listed here;
        # ETag is the revision to send back as If-Match.
        expose_headers=["ETag"],
    )
    app.middleware("http")(request_id_middleware)

    register_exception_handlers(app)

    app.include_router(health.router)
    app.include_router(discovery.router, prefix=API_V1)
    app.include_router(runs.router, prefix=API_V1)
    app.include_router(editing.router, prefix=API_V1)
    app.include_router(openai_compat.router)
    app.include_router(metrics.router)

    return app


app: FastAPI = create_app()
