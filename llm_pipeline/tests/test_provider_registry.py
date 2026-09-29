"""The provider registry's cache: one provider per model and settings, reused
across runs — and bounded, keeping the most recently used."""

import pytest

import llm_pipeline.providers.registry as registry_module
from llm_pipeline.providers import ModelSpec, ProviderType, clear_provider_cache, get_provider


def test_a_provider_is_reused_for_the_same_model_and_settings() -> None:
    clear_provider_cache()
    spec = ModelSpec(ProviderType.OLLAMA, "m", temperature=0.1)
    assert get_provider(spec) is get_provider(ModelSpec(ProviderType.OLLAMA, "m", temperature=0.1))
    assert get_provider(spec) is not get_provider(ModelSpec(ProviderType.OLLAMA, "m", 0.2))


def test_the_cache_is_bounded_and_forgets_the_least_recently_used(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Draft test runs let a client pick any temperature and options, and
    each combination is cached separately — an unbounded cache would keep
    every one ever tried for the life of the process."""
    monkeypatch.setattr(registry_module, "_MAX_CACHED_PROVIDERS", 2)
    clear_provider_cache()
    a, b, c = (ModelSpec(ProviderType.OLLAMA, "m", temperature=t) for t in (0.1, 0.2, 0.3))
    first_a, first_b = get_provider(a), get_provider(b)
    assert get_provider(a) is first_a  # cached, and now the most recently used
    get_provider(c)  # a third: b, the least recently used, is dropped
    assert get_provider(a) is first_a
    assert get_provider(b) is not first_b  # built again
