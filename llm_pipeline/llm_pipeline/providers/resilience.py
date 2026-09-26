"""
Resilience primitives: timeout, retry-with-backoff, circuit breaker.

Deliberately generic — nothing here is LLM-specific beyond the LLMProvider
Protocol/ModelSpec types used for identity/logging. A future `retrieval` or
`tool` node type could reuse generate_with_timeout's shape (or a close
variant) against a different kind of backend call.
"""

import asyncio
import time
from collections.abc import Callable

from llm_pipeline.providers.base import (
    Generation,
    LLMProvider,
    ModelSpec,
    ProviderError,
    as_generation,
)
from llm_pipeline.settings import settings


async def generate_with_timeout(
    provider: LLMProvider,
    prompt: str,
    spec: ModelSpec,
    timeout_seconds: float,
    system: str | None = None,
) -> Generation:
    """Runs provider.generate() with a hard timeout, raising ProviderError on either
    a timeout or any other failure. Centralizing this here means callers never
    have to know the difference between "OpenAI raised an API error" and
    "Ollama hung" — they just catch ProviderError."""
    try:
        return as_generation(
            await asyncio.wait_for(
                provider.generate(prompt, system=system), timeout=timeout_seconds
            )
        )
    except TimeoutError as e:
        raise ProviderError(spec.identity, e) from e
    except Exception as e:
        raise ProviderError(spec.identity, e) from e


# ---------------------------------------------------------------------------
# Circuit breaker
# ---------------------------------------------------------------------------


class _CircuitBreakerState:
    def __init__(self) -> None:
        self.consecutive_failures = 0
        self.opened_at: float | None = None


class CircuitBreaker:
    """Per-model-identity circuit breaker: after `failure_threshold`
    consecutive failures, stops attempting calls to that model for
    `cooldown_seconds` — failing fast instead of paying the timeout cost on
    every request for a model that's known to be down — then allows one
    trial call once the cooldown elapses to check if it's recovered.

    Explicitly constructible (not just a bare module global) so callers can
    inject their own instance instead of always sharing the process-wide
    default below — see pipeline_loader.py, which owns one CircuitBreaker
    per PipelineCache instance rather than relying on a bare singleton."""

    def __init__(self, failure_threshold: int, cooldown_seconds: float) -> None:
        self.failure_threshold = failure_threshold
        self.cooldown_seconds = cooldown_seconds
        self._states: dict[str, _CircuitBreakerState] = {}

    def is_open(self, key: str) -> bool:
        state = self._states.get(key)
        if state is None or state.opened_at is None:
            return False
        # Once the cooldown has elapsed the circuit is half-open: allow a
        # trial call.
        return time.monotonic() - state.opened_at < self.cooldown_seconds

    def record_success(self, key: str) -> None:
        self._states[key] = _CircuitBreakerState()

    def record_failure(self, key: str) -> None:
        state = self._states.setdefault(key, _CircuitBreakerState())
        state.consecutive_failures += 1
        if state.consecutive_failures >= self.failure_threshold:
            state.opened_at = time.monotonic()

    def reset(self) -> None:
        """Clears all tracked state — a proper public method rather than
        having callers reach into `_states` directly."""
        self._states.clear()


# A process-wide default instance, used when a caller doesn't inject its own
# (e.g. simple scripts, ad-hoc usage, or code that predates DI-style
# construction). Real request-serving code should prefer an explicitly
# constructed/injected instance — see pipeline_loader.PipelineCache.
_default_circuit_breaker = CircuitBreaker(
    settings.circuit_breaker_failure_threshold, settings.circuit_breaker_cooldown_seconds
)


def reset_circuit_breaker() -> None:
    """Clears the process-wide default circuit breaker's state. Only
    affects `_default_circuit_breaker` — any explicitly-constructed/injected
    CircuitBreaker instances elsewhere (e.g. one owned by a PipelineCache)
    have their own independent state and need their own `.reset()` call.
    Call this in an autouse test fixture between tests — see
    tests/conftest.py."""
    _default_circuit_breaker.reset()


# ---------------------------------------------------------------------------
# Retry with backoff (composes with a circuit breaker)
# ---------------------------------------------------------------------------


async def generate_with_retry(
    provider: LLMProvider,
    prompt: str,
    spec: ModelSpec,
    timeout_seconds: float,
    max_attempts: int = 2,
    backoff_base_seconds: float = 1.0,
    circuit_breaker: CircuitBreaker | None = None,
    system: str | None = None,
    on_retry: Callable[[int], None] | None = None,
) -> Generation:
    """Wraps generate_with_timeout with a circuit breaker check and
    retry-with-exponential-backoff. This is the function callers should use
    day-to-day — generate_with_timeout stays available as the lower-level
    primitive for callers that want a single bare attempt (e.g. tests).

    `circuit_breaker` defaults to the process-wide default instance if not
    given explicitly — pass your own to use an independently-scoped
    instance instead (e.g. one owned by a specific PipelineCache), which is
    what genuine dependency injection looks like here: this function never
    reaches for a hardcoded global by name, it just falls back to one if the
    caller doesn't provide an alternative.

    The circuit breaker check happens BEFORE attempting any call: if this
    model has failed too many times recently, fail immediately without
    consuming a retry attempt or paying the timeout cost again.

    Retries apply only to ProviderError (transient failures) and never
    exceed max_attempts total, including the first try. `on_retry(n)` is
    called just before attempt n (n >= 2) — streaming callers use it to tell
    clients to discard partial output from the failed attempt.
    """
    breaker = circuit_breaker if circuit_breaker is not None else _default_circuit_breaker

    if breaker.is_open(spec.identity):
        raise ProviderError(
            spec.identity,
            RuntimeError(
                f"circuit open after {breaker.failure_threshold}+ consecutive "
                f"failures — skipping call (cooldown {breaker.cooldown_seconds}s)"
            ),
        )

    last_error: ProviderError | None = None
    for attempt in range(max_attempts):
        if attempt > 0 and on_retry is not None:
            on_retry(attempt + 1)
        try:
            result = await generate_with_timeout(
                provider, prompt, spec, timeout_seconds, system=system
            )
            breaker.record_success(spec.identity)
            return result
        except ProviderError as e:
            last_error = e
            breaker.record_failure(spec.identity)
            if attempt < max_attempts - 1:
                await asyncio.sleep(backoff_base_seconds * (2**attempt))

    assert last_error is not None
    raise last_error
