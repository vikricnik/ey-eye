"""
Resilience primitives: timeout, retry-with-backoff, circuit breaker.

Deliberately generic — nothing here is LLM-specific beyond the LLMProvider
Protocol/ModelSpec types used for identity/logging. A future `retrieval` or
`tool` node type could reuse generate_with_timeout's shape (or a close
variant) against a different kind of backend call.
"""

import asyncio
import logging
import time
from collections.abc import Callable

from llm_pipeline import metrics
from llm_pipeline.providers.base import (
    Generation,
    LLMProvider,
    ModelSpec,
    ProviderError,
    RetryPolicy,
)
from llm_pipeline.settings import settings

logger: logging.Logger = logging.getLogger("llm_pipeline")


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
        return await asyncio.wait_for(
            provider.generate(prompt, system=system), timeout=timeout_seconds
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
        # When the half-open circuit's one trial call started, if one has.
        self.trial_started_at: float | None = None


class CircuitBreaker:
    """Per-model-identity circuit breaker: after `failure_threshold`
    consecutive failures, stops attempting calls to that model for
    `cooldown_seconds` — failing fast instead of paying the timeout cost on
    every request for a model that's known to be down — then allows one
    trial call once the cooldown elapses to check if it's recovered. Every
    other caller keeps failing fast until that trial's outcome is recorded,
    so a recovering model isn't hit by every request that queued up while
    it was down.

    Explicitly constructible (not just a bare module global) so callers can
    inject their own instance instead of always sharing the process-wide
    default below — see pipeline_loader.py, which owns one CircuitBreaker
    per PipelineCache instance rather than relying on a bare singleton."""

    def __init__(
        self,
        failure_threshold: int,
        cooldown_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.failure_threshold = failure_threshold
        self.cooldown_seconds = cooldown_seconds
        # What "now" is — replaceable, so tests move time on instead of
        # sleeping through cooldowns.
        self._clock = clock
        self._states: dict[str, _CircuitBreakerState] = {}

    def is_open(self, key: str) -> bool:
        state = self._states.get(key)
        if state is None or state.opened_at is None:
            return False
        # Once the cooldown has elapsed the circuit is half-open: allow a
        # trial call.
        return self._clock() - state.opened_at < self.cooldown_seconds

    def allow_call(self, key: str) -> bool:
        """Whether a call to `key` may go ahead now — ask right before each
        attempt. Closed: yes. Open: no. Half-open: yes for exactly one
        caller, which becomes the trial call. A trial whose outcome is never
        recorded (its request was cancelled) is replaced after another
        cooldown, so it can't hold the circuit shut for good."""
        state = self._states.get(key)
        if state is None or state.opened_at is None:
            return True
        now = self._clock()
        if now - state.opened_at < self.cooldown_seconds:
            return False
        trial = state.trial_started_at
        if trial is not None and now - trial < self.cooldown_seconds:
            return False
        state.trial_started_at = now
        return True

    def record_success(self, key: str) -> None:
        self._states[key] = _CircuitBreakerState()

    def record_failure(self, key: str) -> None:
        """Counts a failure. Opening the circuit — from closed, or again
        when the half-open trial call fails — is logged and counted once;
        failures of calls that were already in flight when it opened only
        restart the cooldown."""
        state = self._states.setdefault(key, _CircuitBreakerState())
        state.consecutive_failures += 1
        state.trial_started_at = None
        if state.consecutive_failures >= self.failure_threshold:
            was_open = self.is_open(key)
            state.opened_at = self._clock()
            if not was_open:
                logger.warning(
                    f"circuit opened for {key} after {state.consecutive_failures} "
                    f"consecutive failures — calls fail fast for {self.cooldown_seconds}s"
                )
                metrics.count_circuit_opened(key)

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
    policy: RetryPolicy,
    *,
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

    The circuit breaker is asked BEFORE EVERY attempt, retries included: if
    this model has failed too many times recently, fail immediately without
    paying the timeout cost again. A circuit that opens partway through
    (this request's own failures, or concurrent ones, reached the
    threshold) ends the retrying — with the last error this request
    actually saw, which says more than "circuit open".

    Retries apply only to ProviderError (transient failures) and never
    exceed policy.max_attempts total, including the first try. `on_retry(n)` is
    called just before attempt n (n >= 2) — streaming callers use it to tell
    clients to discard partial output from the failed attempt.

    Every attempt is counted and timed by its result, with the tokens a
    successful one used (see metrics.py); an attempt the breaker refuses is
    counted, not timed — it never reached the model.
    """
    breaker = circuit_breaker if circuit_breaker is not None else _default_circuit_breaker

    last_error: ProviderError | None = None
    for attempt in range(policy.max_attempts):
        if not breaker.allow_call(spec.identity):
            metrics.record_model_call(spec.identity, "circuit_open")
            if last_error is not None:
                raise last_error
            raise ProviderError(
                spec.identity,
                RuntimeError(
                    f"circuit open after {breaker.failure_threshold}+ consecutive "
                    f"failures — skipping call (cooldown {breaker.cooldown_seconds}s)"
                ),
            )
        if attempt > 0 and on_retry is not None:
            on_retry(attempt + 1)
        started_at = time.monotonic()
        try:
            result = await generate_with_timeout(
                provider, prompt, spec, policy.timeout_seconds, system=system
            )
            breaker.record_success(spec.identity)
            metrics.record_model_call(spec.identity, "ok", started_at)
            if result.usage is not None:
                metrics.count_tokens(
                    spec.identity, result.usage.prompt_tokens, result.usage.completion_tokens
                )
            return result
        except ProviderError as e:
            last_error = e
            timed_out = isinstance(e.original, TimeoutError)
            metrics.record_model_call(
                spec.identity, "timeout" if timed_out else "failed", started_at
            )
            breaker.record_failure(spec.identity)
            if attempt < policy.max_attempts - 1:
                await asyncio.sleep(policy.backoff_base_seconds * (2**attempt))

    assert last_error is not None
    raise last_error
