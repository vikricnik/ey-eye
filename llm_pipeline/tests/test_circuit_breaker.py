import asyncio
import time

import pytest

from llm_pipeline.pipeline_config import ExecutionConfig
from llm_pipeline.providers import (
    CircuitBreaker,
    Generation,
    ModelSpec,
    ProviderError,
    ProviderType,
    RetryPolicy,
    generate_with_retry,
)

# Two attempts, barely waiting in between.
_QUICK_RETRY = RetryPolicy(timeout_seconds=5.0, max_attempts=2, backoff_base_seconds=0.01)


def test_a_pipelines_retries_are_attempts_after_the_first() -> None:
    execution = ExecutionConfig(model_timeout_seconds=30, max_retries=2, retry_backoff_seconds=0.5)
    assert RetryPolicy.from_execution(execution) == RetryPolicy(
        timeout_seconds=30, max_attempts=3, backoff_base_seconds=0.5
    )


def test_circuit_starts_closed() -> None:
    cb = CircuitBreaker(failure_threshold=3, cooldown_seconds=1.0)
    assert cb.is_open("model-x") is False


def test_circuit_opens_at_failure_threshold() -> None:
    cb = CircuitBreaker(failure_threshold=3, cooldown_seconds=10.0)
    cb.record_failure("model-x")
    cb.record_failure("model-x")
    assert cb.is_open("model-x") is False  # below threshold
    cb.record_failure("model-x")
    assert cb.is_open("model-x") is True  # hit threshold


def test_circuit_closes_after_cooldown() -> None:
    cb = CircuitBreaker(failure_threshold=1, cooldown_seconds=0.2)
    cb.record_failure("model-x")
    assert cb.is_open("model-x") is True
    time.sleep(0.25)
    assert cb.is_open("model-x") is False  # cooldown elapsed


def test_success_resets_failure_count() -> None:
    cb = CircuitBreaker(failure_threshold=2, cooldown_seconds=10.0)
    cb.record_failure("model-x")
    cb.record_success("model-x")
    cb.record_failure("model-x")
    assert cb.is_open("model-x") is False  # only 1 failure since the reset


def test_different_models_tracked_independently() -> None:
    cb = CircuitBreaker(failure_threshold=1, cooldown_seconds=10.0)
    cb.record_failure("model-x")
    assert cb.is_open("model-x") is True
    assert cb.is_open("model-y") is False


class _FlakyProvider:
    """Fails a fixed number of times, then succeeds — simulates a transient
    error that a retry should recover from."""

    def __init__(self, fail_times: int, success_message: str = "ok") -> None:
        self.fail_times = fail_times
        self.success_message = success_message
        self.call_count = 0

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        self.call_count += 1
        if self.call_count <= self.fail_times:
            raise RuntimeError("transient failure")
        return Generation(self.success_message)


class _AlwaysFailingProvider:
    def __init__(self) -> None:
        self.call_count = 0

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        self.call_count += 1
        raise RuntimeError("permanent failure")


@pytest.mark.asyncio
async def test_retry_recovers_from_transient_failure() -> None:
    provider = _FlakyProvider(fail_times=1)  # fails once, then succeeds
    spec = ModelSpec(ProviderType.OLLAMA, "retry-test-model-1")

    result = await generate_with_retry(provider, "prompt", spec, _QUICK_RETRY)
    assert result.text == "ok"
    assert provider.call_count == 2  # first attempt failed, second succeeded


@pytest.mark.asyncio
async def test_retry_gives_up_after_max_attempts() -> None:
    provider = _AlwaysFailingProvider()
    spec = ModelSpec(ProviderType.OLLAMA, "retry-test-model-2")

    with pytest.raises(ProviderError):
        await generate_with_retry(provider, "prompt", spec, _QUICK_RETRY)
    # exactly max_attempts calls were made, not more


def test_half_open_circuit_admits_one_trial_call() -> None:
    cb = CircuitBreaker(failure_threshold=1, cooldown_seconds=0.05)
    cb.record_failure("model-x")
    assert cb.allow_call("model-x") is False  # open
    time.sleep(0.06)
    assert cb.allow_call("model-x") is True  # the trial call
    assert cb.allow_call("model-x") is False  # everyone else still fails fast
    cb.record_success("model-x")
    assert cb.allow_call("model-x") is True  # recovered: closed again
    assert cb.allow_call("model-x") is True


def test_failed_trial_call_reopens_the_circuit() -> None:
    cb = CircuitBreaker(failure_threshold=1, cooldown_seconds=0.05)
    cb.record_failure("model-x")
    time.sleep(0.06)
    assert cb.allow_call("model-x") is True
    cb.record_failure("model-x")
    assert cb.is_open("model-x") is True
    assert cb.allow_call("model-x") is False


def test_abandoned_trial_call_is_replaced_after_a_cooldown() -> None:
    """A trial call whose outcome never comes back (its request was
    cancelled) mustn't hold the circuit shut for good."""
    cb = CircuitBreaker(failure_threshold=1, cooldown_seconds=0.05)
    cb.record_failure("model-x")
    time.sleep(0.06)
    assert cb.allow_call("model-x") is True  # claimed, then abandoned
    assert cb.allow_call("model-x") is False
    time.sleep(0.06)
    assert cb.allow_call("model-x") is True


@pytest.mark.asyncio
async def test_retries_stop_once_the_circuit_opens() -> None:
    """Retrying into a model the breaker has given up on is exactly what the
    breaker is for — the request fails with the error it actually saw."""
    provider = _AlwaysFailingProvider()
    spec = ModelSpec(ProviderType.OLLAMA, "retry-test-model-3")
    breaker = CircuitBreaker(failure_threshold=2, cooldown_seconds=60.0)
    policy = RetryPolicy(timeout_seconds=5.0, max_attempts=5, backoff_base_seconds=0.01)
    announced: list[int] = []

    with pytest.raises(ProviderError, match="permanent failure"):
        await generate_with_retry(
            provider, "prompt", spec, policy, circuit_breaker=breaker, on_retry=announced.append
        )
    assert provider.call_count == 2  # not 5
    assert announced == [2]  # no retry announced that never ran


@pytest.mark.asyncio
async def test_a_recovering_model_gets_one_trial_call_not_every_waiting_request() -> None:
    release = asyncio.Event()
    calls = 0

    class _SlowProvider:
        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            nonlocal calls
            calls += 1
            await release.wait()
            return Generation("ok")

    spec = ModelSpec(ProviderType.OLLAMA, "retry-test-model-4")
    breaker = CircuitBreaker(failure_threshold=1, cooldown_seconds=0.05)
    breaker.record_failure(spec.identity)
    await asyncio.sleep(0.06)  # cooldown over: half-open
    policy = RetryPolicy(timeout_seconds=5.0, max_attempts=1)

    trial = asyncio.ensure_future(
        generate_with_retry(_SlowProvider(), "p", spec, policy, circuit_breaker=breaker)
    )
    await asyncio.sleep(0)  # the trial call is now in flight
    others = await asyncio.gather(
        *(
            generate_with_retry(_SlowProvider(), "p", spec, policy, circuit_breaker=breaker)
            for _ in range(5)
        ),
        return_exceptions=True,
    )
    assert all(isinstance(e, ProviderError) and "circuit open" in str(e) for e in others)
    release.set()
    assert (await trial).text == "ok"
    assert calls == 1
