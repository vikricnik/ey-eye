"""
App composition root: creates the FastAPI app, wires middleware, sets up
app.state.pipeline_cache (dependency-injected into routers via
pipeline_loader.get_pipeline_cache — see that module's docstring for why
this replaced a bare module-level global), registers exception handlers,
and includes the routers. No route logic or business logic lives here
directly — see routers/health.py, routers/ask.py, error_handling.py,
pipeline_loader.py.
"""

import logging
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from llm_pipeline.error_handling import register_exception_handlers
from llm_pipeline.logging_context import configure_logging, request_id_middleware
from llm_pipeline.pipeline_config import load_pipeline_definition
from llm_pipeline.pipeline_loader import PipelineCache
from llm_pipeline.routers import ask, health
from llm_pipeline.settings import settings

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
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    _validate_pipelines_at_startup()
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
    )
    yield


def create_app() -> FastAPI:
    """Factory, not just a module-level `app = FastAPI(...)` — makes it
    possible to construct multiple independent app instances (each with
    their own PipelineCache on app.state) in the same process, e.g. one per
    test, without any risk of cross-instance state leakage."""
    app = FastAPI(title="LLM Pipeline", version="3.1.0", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.middleware("http")(request_id_middleware)

    register_exception_handlers(app)

    app.include_router(health.router)
    app.include_router(ask.router)

    return app


app: FastAPI = create_app()
