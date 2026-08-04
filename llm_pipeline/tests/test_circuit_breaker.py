import time
import pytest

from llm_pipeline.providers import (
    CircuitBreaker,
    ModelSpec,
    ProviderError,
    ProviderType,
    generate_with_retry,
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

    async def generate(self, prompt: str) -> str:
        self.call_count += 1
        if self.call_count <= self.fail_times:
            raise RuntimeError("transient failure")
        return self.success_message


class _AlwaysFailingProvider:
    async def generate(self, prompt: str) -> str:
        raise RuntimeError("permanent failure")


@pytest.mark.asyncio
async def test_retry_recovers_from_transient_failure() -> None:
    provider = _FlakyProvider(fail_times=1)  # fails once, then succeeds
    spec = ModelSpec(ProviderType.OLLAMA, "retry-test-model-1")

    result = await generate_with_retry(
        provider, "prompt", spec, timeout_seconds=5.0, max_attempts=2, backoff_base_seconds=0.01
    )
    assert result == "ok"
    assert provider.call_count == 2  # first attempt failed, second succeeded


@pytest.mark.asyncio
async def test_retry_gives_up_after_max_attempts() -> None:
    provider = _AlwaysFailingProvider()
    spec = ModelSpec(ProviderType.OLLAMA, "retry-test-model-2")

    with pytest.raises(ProviderError):
        await generate_with_retry(
            provider, "prompt", spec, timeout_seconds=5.0, max_attempts=2, backoff_base_seconds=0.01
        )
    # exactly max_attempts calls were made, not more
