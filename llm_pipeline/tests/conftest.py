import pytest

from llm_pipeline.providers import reset_circuit_breaker


@pytest.fixture(autouse=True)
def _reset_circuit_breaker_between_tests() -> None:
    """The circuit breaker in providers.py is a process-wide singleton keyed
    by model identity (e.g. "ollama:test-model"). Several test fixtures
    reuse the same identity across different scenarios — one test's
    deliberate failures could otherwise open the circuit for a later,
    unrelated test using the same identity, causing it to fail with
    "circuit open" before ever reaching its (working) mocked provider."""
    reset_circuit_breaker()
