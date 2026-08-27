from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.main import app
from llm_pipeline.settings import settings


@pytest.fixture(autouse=True)
def _reset_shared_state(monkeypatch: pytest.MonkeyPatch) -> None:  # pyright: ignore[reportUnusedFunction]
    """Same reasoning as test_streaming.py's fixture of the same name — auth/
    rate-limit are process-wide singletons needing an explicit reset."""
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app) as c:
        yield c


def test_pipeline_detail_exposes_structured_branch_routes(client: TestClient) -> None:
    """GET /pipelines/{name} must expose each branch route's `when`
    condition and `default` flag, not just its target node id — the visual
    DAG graph feature (FR-004) needs this to label branch edges."""
    response = client.get("/pipelines/support-router")
    assert response.status_code == 200
    body = response.json()

    assert len(body["branches"]) == 1
    branch = body["branches"][0]
    assert branch["id"] == "route_by_intent"
    assert branch["from"] == "classify"

    routes_by_target = {r["to"]: r for r in branch["routes"]}
    assert routes_by_target["refund_flow"]["when"] == '"REFUND" in output'
    assert routes_by_target["refund_flow"]["default"] is False
    assert routes_by_target["tech_support_flow"]["when"] == '"TECHNICAL" in output'
    assert routes_by_target["tech_support_flow"]["default"] is False
    assert routes_by_target["general_flow"]["when"] is None
    assert routes_by_target["general_flow"]["default"] is True


def test_pipeline_detail_exposes_loop_on_max_iterations(client: TestClient) -> None:
    """GET /pipelines/{name} must expose on_max_iterations so the graph can
    distinguish a loop that exited normally from one that exhausted its
    iterations (spec.md edge case)."""
    response = client.get("/pipelines/iterative-refinement")
    assert response.status_code == 200
    body = response.json()

    assert len(body["loops"]) == 1
    loop = body["loops"][0]
    assert loop["id"] == "revise_until_approved"
    assert loop["from"] == "critique"
    assert loop["back_to"] == "generate"
    assert loop["exit_to"] == "END"
    assert loop["max_iterations"] == 3
    assert loop["on_max_iterations"] == "proceed"
