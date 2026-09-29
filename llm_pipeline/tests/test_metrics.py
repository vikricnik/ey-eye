"""Metrics to alert on: runs by how they ended and how long they took,
model calls by result and duration, tokens used, circuits opening, and
429s — served at GET /metrics.

Metrics live for the whole test process, so every check is a difference:
the value after, minus the value before."""

import asyncio
import gc
import logging
from collections.abc import Iterator
from pathlib import Path
from typing import cast

import pytest
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

import llm_pipeline.dag_builder.node_types as node_types_module
import llm_pipeline.disconnects as disconnects_module
import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.api_schemas import RunRequest
from llm_pipeline.main import app
from llm_pipeline.pipeline_loader import PipelineCache
from llm_pipeline.providers import (
    CircuitBreaker,
    Generation,
    ModelSpec,
    ProviderError,
    ProviderType,
    RetryPolicy,
    Usage,
    generate_with_retry,
)
from llm_pipeline.rate_limit import RateLimiter
from llm_pipeline.routers.runs import pipeline_events, prepare_run, run_pipeline
from llm_pipeline.settings import settings

# Asks a run to stream its progress as Server-Sent Events.
STREAM = {"Accept": "text/event-stream"}


def _count(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def _runs(pipeline: str, outcome: str) -> float:
    return _count("llm_pipeline_runs_total", pipeline=pipeline, outcome=outcome)


def _model_calls(model: str, outcome: str) -> float:
    return _count("llm_pipeline_model_calls_total", model=model, outcome=outcome)


def _timed_runs(pipeline: str, outcome: str) -> float:
    """How many runs the duration histogram has observed."""
    return _count("llm_pipeline_run_duration_seconds_count", pipeline=pipeline, outcome=outcome)


def _tokens(model: str, kind: str) -> float:
    return _count("llm_pipeline_tokens_total", model=model, kind=kind)


class _EchoProvider:
    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        return Generation(f"echo:{prompt}")


class _FailingProvider:
    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        raise RuntimeError("simulated failure")


@pytest.fixture(autouse=True)
def _reset_shared_state(monkeypatch: pytest.MonkeyPatch) -> None:  # pyright: ignore[reportUnusedFunction]
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(rate_limit_module, "_limiter", RateLimiter(1000))
    monkeypatch.setattr(disconnects_module, "POLL_SECONDS", 0.01)


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


# -- runs ----------------------------------------------------------------------


@pytest.mark.parametrize("accept", [{}, STREAM], ids=["answered", "streamed"])
def test_runs_are_counted_and_timed_by_how_they_ended(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, accept: dict[str, str]
) -> None:
    completed = _runs("simple-local", "completed")
    failed = _runs("simple-local", "failed")
    timed_completed = _timed_runs("simple-local", "completed")
    timed_failed = _timed_runs("simple-local", "failed")

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _EchoProvider())
    run = {"prompt": "hello", "history": []}
    assert client.post("/v1/workflows/simple-local/runs", json=run, headers=accept).is_success

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _FailingProvider())
    client.post("/v1/workflows/simple-local/runs", json=run, headers=accept)

    assert _runs("simple-local", "completed") == completed + 1
    assert _runs("simple-local", "failed") == failed + 1
    assert _timed_runs("simple-local", "completed") == timed_completed + 1
    assert _timed_runs("simple-local", "failed") == timed_failed + 1


def test_a_request_refused_before_its_run_starts_is_no_run(client: TestClient) -> None:
    """Bad input is the client's mistake, not a failing run — counting it
    would page someone over a typo."""
    before = _runs("simple-local", "failed") + _runs("simple-local", "completed")
    empty = {"prompt": "  ", "history": []}
    assert client.post("/v1/workflows/simple-local/runs", json=empty).status_code == 400
    assert _runs("simple-local", "failed") + _runs("simple-local", "completed") == before


class _Client:
    """Stands in for a Request whose client can leave (see test_disconnects.py)."""

    method = "POST"

    class url:
        path = "/v1/workflows/slow/runs"

    def __init__(self) -> None:
        self.gone = False

    async def is_disconnected(self) -> bool:
        return self.gone


class _Hanging:
    def __init__(self) -> None:
        self.started = asyncio.Event()

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        self.started.set()
        await asyncio.Event().wait()
        raise AssertionError("never finishes")


SLOW_PIPELINE = """\
name: slow
nodes:
  - id: answer
    model: {provider: ollama, name: m}
    prompt_template: "{{ input }}"
output_nodes: [answer]
"""


@pytest.mark.asyncio
async def test_a_run_whose_client_leaves_is_counted_cancelled(tmp_path: Path) -> None:
    hanging = _Hanging()
    (tmp_path / "slow.yaml").write_text(SLOW_PIPELINE)
    cache = PipelineCache(tmp_path, provider_factory=lambda spec: hanging)
    client = _Client()
    request = cast(Request, client)
    before = _runs("slow", "cancelled")
    timed_before = _timed_runs("slow", "cancelled")

    answered = asyncio.ensure_future(run_pipeline("slow", RunRequest(prompt="q"), cache, request))
    await hanging.started.wait()
    client.gone = True
    with pytest.raises(HTTPException):
        await asyncio.wait_for(answered, timeout=2)
    assert _runs("slow", "cancelled") == before + 1

    hanging.started.clear()
    client.gone = False
    run = await prepare_run("slow", RunRequest(prompt="q"), cache)
    events = pipeline_events(request, run)
    assert (await anext(events))[0] == "node_start"
    waiting = asyncio.ensure_future(anext(events))
    await hanging.started.wait()
    waiting.cancel()  # what until_disconnected does once the client leaves
    with pytest.raises(asyncio.CancelledError):
        await waiting
    assert _runs("slow", "cancelled") == before + 2
    assert _timed_runs("slow", "cancelled") == timed_before + 2
    # LangGraph leaves a cancelled internal coroutine to the garbage
    # collector; finalize it while this test's event loop still runs.
    await asyncio.sleep(0.05)
    gc.collect()


@pytest.mark.asyncio
async def test_a_run_past_its_time_limit_is_counted_timed_out(tmp_path: Path) -> None:
    hanging = _Hanging()
    (tmp_path / "bounded.yaml").write_text(
        SLOW_PIPELINE.replace("name: slow", "name: bounded\nexecution: {run_timeout_seconds: 0.1}")
    )
    cache = PipelineCache(tmp_path, provider_factory=lambda spec: hanging)
    before = _runs("bounded", "timed_out")
    timed_before = _timed_runs("bounded", "timed_out")
    with pytest.raises(HTTPException) as raised:
        await run_pipeline("bounded", RunRequest(prompt="q"), cache, cast(Request, _Client()))
    assert raised.value.status_code == 504
    assert _runs("bounded", "timed_out") == before + 1
    assert _timed_runs("bounded", "timed_out") == timed_before + 1
    # LangGraph leaves a cancelled internal coroutine to the garbage
    # collector; finalize it while this test's event loop still runs.
    await asyncio.sleep(0.05)
    gc.collect()


# -- model calls and the circuit breaker ----------------------------------------


@pytest.mark.asyncio
async def test_model_calls_are_counted_per_attempt() -> None:
    class _FailsOnce:
        calls = 0

        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("transient")
            return Generation("ok")

    spec = ModelSpec(ProviderType.OLLAMA, "metrics-flaky")
    ok, failed = _model_calls(spec.identity, "ok"), _model_calls(spec.identity, "failed")
    policy = RetryPolicy(timeout_seconds=5.0, max_attempts=2, backoff_base_seconds=0.01)
    await generate_with_retry(
        _FailsOnce(), "p", spec, policy, circuit_breaker=CircuitBreaker(5, 60)
    )
    assert _model_calls(spec.identity, "failed") == failed + 1
    assert _model_calls(spec.identity, "ok") == ok + 1


@pytest.mark.asyncio
async def test_a_timed_out_model_call_is_counted_as_a_timeout() -> None:
    class _Slow:
        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            await asyncio.sleep(5)
            return Generation("late")

    spec = ModelSpec(ProviderType.OLLAMA, "metrics-slow")
    before = _model_calls(spec.identity, "timeout")
    policy = RetryPolicy(timeout_seconds=0.05, max_attempts=1)
    with pytest.raises(ProviderError):
        await generate_with_retry(_Slow(), "p", spec, policy, circuit_breaker=CircuitBreaker(5, 60))
    assert _model_calls(spec.identity, "timeout") == before + 1


@pytest.mark.asyncio
async def test_a_call_the_open_circuit_refuses_is_counted() -> None:
    spec = ModelSpec(ProviderType.OLLAMA, "metrics-refused")
    breaker = CircuitBreaker(failure_threshold=1, cooldown_seconds=60)
    breaker.record_failure(spec.identity)
    before = _model_calls(spec.identity, "circuit_open")
    with pytest.raises(ProviderError, match="circuit open"):
        await generate_with_retry(
            _EchoProvider(), "p", spec, RetryPolicy(5.0), circuit_breaker=breaker
        )
    assert _model_calls(spec.identity, "circuit_open") == before + 1
    # Refused without calling: nothing to time.
    assert (
        _count(
            "llm_pipeline_model_call_duration_seconds_count",
            model=spec.identity,
            outcome="circuit_open",
        )
        == 0
    )


@pytest.mark.asyncio
async def test_each_model_call_attempt_is_timed() -> None:
    class _FailsFastThenAnswers:
        calls = 0

        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("transient")
            await asyncio.sleep(0.05)
            return Generation("ok")

    spec = ModelSpec(ProviderType.OLLAMA, "metrics-timed")
    name = "llm_pipeline_model_call_duration_seconds"
    ok_count = _count(f"{name}_count", model=spec.identity, outcome="ok")
    ok_sum = _count(f"{name}_sum", model=spec.identity, outcome="ok")
    failed_count = _count(f"{name}_count", model=spec.identity, outcome="failed")
    policy = RetryPolicy(timeout_seconds=5.0, max_attempts=2, backoff_base_seconds=0.01)
    await generate_with_retry(
        _FailsFastThenAnswers(), "p", spec, policy, circuit_breaker=CircuitBreaker(5, 60)
    )
    assert _count(f"{name}_count", model=spec.identity, outcome="failed") == failed_count + 1
    assert _count(f"{name}_count", model=spec.identity, outcome="ok") == ok_count + 1
    # The answer took at least its 0.05 s; the backoff before it isn't counted.
    assert 0.05 <= _count(f"{name}_sum", model=spec.identity, outcome="ok") - ok_sum < 1


@pytest.mark.asyncio
async def test_tokens_are_counted_when_the_backend_reports_them() -> None:
    class _Reporting:
        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            return Generation("ok", Usage(prompt_tokens=12, completion_tokens=5))

    spec = ModelSpec(ProviderType.OLLAMA, "metrics-tokens")
    prompt, completion = _tokens(spec.identity, "prompt"), _tokens(spec.identity, "completion")
    policy = RetryPolicy(timeout_seconds=5.0, max_attempts=1)
    breaker = CircuitBreaker(5, 60)
    await generate_with_retry(_Reporting(), "p", spec, policy, circuit_breaker=breaker)
    # A backend that reports no usage adds nothing.
    await generate_with_retry(_EchoProvider(), "p", spec, policy, circuit_breaker=breaker)
    assert _tokens(spec.identity, "prompt") == prompt + 12
    assert _tokens(spec.identity, "completion") == completion + 5


def test_a_circuit_opening_is_counted_and_logged_once_not_per_failure(
    caplog: pytest.LogCaptureFixture,
) -> None:
    key = "ollama:metrics-breaker"
    before = _count("llm_pipeline_circuit_opened_total", model=key)
    now = [0.0]  # the breaker's clock, moved on by hand
    breaker = CircuitBreaker(failure_threshold=2, cooldown_seconds=30, clock=lambda: now[0])
    with caplog.at_level(logging.WARNING, logger="llm_pipeline"):
        for _ in range(4):  # the last two arrive while it's already open
            breaker.record_failure(key)
    assert _count("llm_pipeline_circuit_opened_total", model=key) == before + 1
    assert [r.getMessage() for r in caplog.records if "circuit opened" in r.getMessage()] == [
        f"circuit opened for {key} after 2 consecutive failures — calls fail fast for 30s"
    ]

    now[0] = 30.0
    assert breaker.allow_call(key)  # the trial call…
    breaker.record_failure(key)  # …fails: still down, so it opens again
    assert _count("llm_pipeline_circuit_opened_total", model=key) == before + 2


# -- rate limiting ---------------------------------------------------------------


def test_429s_are_counted() -> None:
    before = _count("llm_pipeline_rate_limited_total")
    limiter = RateLimiter(requests_per_window=1)
    limiter.check("metrics-client")
    with pytest.raises(HTTPException):
        limiter.check("metrics-client")
    assert _count("llm_pipeline_rate_limited_total") == before + 1


# -- GET /metrics ----------------------------------------------------------------


def test_metrics_need_the_api_key_like_everything_but_health(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Labels name pipelines and models — what /pipelines needs a key for —
    so /metrics isn't open the way /health is."""
    monkeypatch.setattr(settings, "api_keys", "scrape-key")
    assert client.get("/metrics").status_code == 401

    response = client.get("/metrics", headers={"Authorization": "Bearer scrape-key"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    for name, kind in (
        ("llm_pipeline_runs_total", "counter"),
        ("llm_pipeline_run_duration_seconds", "histogram"),
        ("llm_pipeline_model_calls_total", "counter"),
        ("llm_pipeline_model_call_duration_seconds", "histogram"),
        ("llm_pipeline_tokens_total", "counter"),
        ("llm_pipeline_circuit_opened_total", "counter"),
        ("llm_pipeline_rate_limited_total", "counter"),
    ):
        assert f"# TYPE {name} {kind}" in response.text


def test_scrapes_are_not_rate_limited(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """A scraper that gets a 429 leaves a gap in every graph and alert."""
    monkeypatch.setattr(rate_limit_module, "_limiter", RateLimiter(1))
    assert client.get("/metrics").status_code == 200
    assert client.get("/metrics").status_code == 200


def test_metrics_are_not_part_of_the_api_schema(client: TestClient) -> None:
    assert "/metrics" not in client.get("/openapi.json").json()["paths"]
