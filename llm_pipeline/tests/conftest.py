import pytest

from llm_pipeline.providers import reset_circuit_breaker


@pytest.fixture(autouse=True)
def _reset_circuit_breaker_between_tests() -> None:  # pyright: ignore[reportUnusedFunction]
    """The circuit breaker in providers.py is a process-wide singleton keyed
    by model identity (e.g. "ollama:test-model"). Several test fixtures
    reuse the same identity across different scenarios — one test's
    deliberate failures could otherwise open the circuit for a later,
    unrelated test using the same identity, causing it to fail with
    "circuit open" before ever reaching its (working) mocked provider.

    (pyright flags this as unused since pytest invokes autouse fixtures via
    its own dependency-injection machinery — nothing in visible code ever
    "calls" it directly, which is a known, harmless false positive for this
    exact pytest pattern.)"""
    reset_circuit_breaker()
