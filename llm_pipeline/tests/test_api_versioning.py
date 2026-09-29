"""Every route of this API is under /v1, so a breaking change can arrive as
/v2 beside it instead of breaking every client at the same moment."""

from collections.abc import Iterator

import pytest
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.main import app
from llm_pipeline.settings import settings

# Called at fixed paths by things that don't speak this API's versions:
# load balancers probe /health, Prometheus scrapes /metrics.
UNVERSIONED = {"/health", "/metrics"}


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))
    with TestClient(app) as c:
        yield c


def test_every_api_route_is_versioned() -> None:
    """The OpenAI-compatible routes follow OpenAI's own /v1, under /openai."""
    paths = {route.path for route in app.routes if isinstance(route, APIRoute)}
    outside = {path for path in paths - UNVERSIONED if not path.startswith(("/v1/", "/openai/v1/"))}
    assert outside == set()
    assert "/v1/workflows/{name}/runs" in paths


def test_the_old_paths_are_gone(client: TestClient) -> None:
    """Neither was ever released, so neither has an alias."""
    assert client.get("/server-info").status_code == 404
    assert client.get("/pipelines").status_code == 404
    assert client.get("/v1/pipelines").status_code == 404  # renamed to /v1/workflows
    assert client.get("/v1/server-info").status_code == 200
    assert client.get("/v1/workflows").status_code == 200
    assert client.get("/health").status_code == 200
