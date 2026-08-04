import pytest
from fastapi.testclient import TestClient

from llm_pipeline.main import app
import llm_pipeline.main as main_module
import llm_pipeline.auth as auth_module
import llm_pipeline.rate_limit as rate_limit_module


@pytest.fixture(autouse=True)
def _reset_shared_state(monkeypatch: pytest.MonkeyPatch) -> None:
    """Auth/rate-limit state and the pipeline cache are process-wide
    singletons — reset them around every test in this file so one test's
    setup can't leak into another's (same category of issue as the circuit
    breaker singleton fixed earlier in conftest.py)."""
    monkeypatch.setattr(auth_module.settings, "api_keys", "")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))
    main_module._pipeline_cache.clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_pipeline_not_found_returns_error_response_shape(client: TestClient) -> None:
    response = client.post(
        "/ask", json={"prompt": "hi", "pipeline_name": "does-not-exist", "history": []}
    )
    assert response.status_code == 404
    body = response.json()
    assert set(body.keys()) == {"detail"}  # exactly ErrorResponse's shape, nothing extra
    assert isinstance(body["detail"], str)
    assert "does-not-exist" in body["detail"]


def test_empty_prompt_returns_error_response_shape(client: TestClient) -> None:
    response = client.post(
        "/ask", json={"prompt": "   ", "pipeline_name": "anything", "history": []}
    )
    assert response.status_code == 400
    body = response.json()
    assert set(body.keys()) == {"detail"}
    assert "empty" in body["detail"].lower()


def test_malformed_request_body_returns_error_response_shape(client: TestClient) -> None:
    """Missing required field `pipeline_name` — FastAPI's automatic 422,
    which normally returns Pydantic's own nested error-list shape, must be
    flattened into the same ErrorResponse contract as every other error."""
    response = client.post("/ask", json={"prompt": "hi"})
    assert response.status_code == 422
    body = response.json()
    assert set(body.keys()) == {"detail"}
    assert isinstance(body["detail"], str)
    assert "pipeline_name" in body["detail"]


def test_missing_api_key_returns_error_response_shape(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(auth_module.settings, "api_keys", "secret-key")
    response = client.post(
        "/ask", json={"prompt": "hi", "pipeline_name": "anything", "history": []}
    )
    assert response.status_code == 401
    body = response.json()
    assert set(body.keys()) == {"detail"}


def test_rate_limit_returns_error_response_shape_with_retry_after(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Confirms the custom exception handler forwards exc.headers correctly
    — easy to silently break when centralizing error handling, since
    Retry-After is specific to this one error type and easy to forget to
    plumb through a shared handler."""
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1))

    client.get("/pipelines")  # consumes the 1 allowed request in the window
    response = client.get("/pipelines")  # 2nd request within the window — should be limited

    assert response.status_code == 429
    body = response.json()
    assert set(body.keys()) == {"detail"}
    assert "Retry-After" in response.headers
