"""GET /health — open, for load balancers — and GET /server-info, which
tells an authenticated client what it needs to start: nothing more than
that in either, and nothing about the server's filesystem."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.main import app
from llm_pipeline.settings import settings


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(settings, "api_keys", "secret")
    monkeypatch.setattr(settings, "pipeline_editing_enabled", False)
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))
    with TestClient(app) as c:
        yield c


def test_health_is_open_and_says_only_that_the_server_is_up(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_server_info_needs_the_api_key(client: TestClient) -> None:
    assert client.get("/server-info").status_code == 401
    info = client.get("/server-info", headers={"X-API-Key": "secret"}).json()
    assert info == {
        "default_pipeline_name": settings.default_pipeline_name,
        "editing_enabled": False,
        "editing_disabled_reason": None,
    }


def test_neither_reveals_the_pipelines_directory(client: TestClient) -> None:
    directory = str(settings.pipelines_path)
    assert directory not in client.get("/health").text
    assert directory not in client.get("/server-info", headers={"X-API-Key": "secret"}).text
