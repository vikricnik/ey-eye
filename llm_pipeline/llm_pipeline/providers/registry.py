"""
Provider factory.

Adding a new provider: add a value to ProviderType (base.py), write an
adapter module implementing LLMProvider (see ollama.py for the simplest
example), then add one branch here. Nothing else in the pipeline needs to
change — every consumer only ever depends on the LLMProvider Protocol.
"""

from collections import OrderedDict

from llm_pipeline.providers.anthropic import AnthropicProvider
from llm_pipeline.providers.base import LLMProvider, ModelSpec, ProviderType
from llm_pipeline.providers.copilot import CopilotProvider
from llm_pipeline.providers.gemini import GeminiProvider
from llm_pipeline.providers.ollama import OllamaProvider
from llm_pipeline.providers.openai import OpenAIProvider

# Providers are cheap-ish to reuse and somewhat wasteful to reconstruct per-request,
# so we cache one instance per unique (provider, model, generation settings)
# combination — see ModelSpec.cache_key. Bounded, least recently used first
# out: draft test runs let a client pick any temperature and options, and
# every combination ever tried would otherwise stay cached. Well above what
# saved pipelines use; past it, a provider is only rebuilt (a call in flight
# keeps its own reference).
_MAX_CACHED_PROVIDERS = 128
_provider_cache: OrderedDict[str, LLMProvider] = OrderedDict()


def get_provider(spec: ModelSpec) -> LLMProvider:
    """Factory: returns a cached provider instance for the given spec."""
    cache_key = spec.cache_key
    cached = _provider_cache.get(cache_key)
    if cached is not None:
        _provider_cache.move_to_end(cache_key)
        return cached

    provider: LLMProvider
    if spec.provider == ProviderType.OLLAMA:
        provider = OllamaProvider(spec)
    elif spec.provider == ProviderType.OPENAI:
        provider = OpenAIProvider(spec)
    elif spec.provider == ProviderType.ANTHROPIC:
        provider = AnthropicProvider(spec)
    elif spec.provider == ProviderType.GEMINI:
        provider = GeminiProvider(spec)
    elif spec.provider == ProviderType.COPILOT:
        provider = CopilotProvider(spec)
    else:
        raise ValueError(f"Unknown provider: {spec.provider}")

    _provider_cache[cache_key] = provider
    if len(_provider_cache) > _MAX_CACHED_PROVIDERS:
        _provider_cache.popitem(last=False)
    return provider


def clear_provider_cache() -> None:
    """Public accessor for resetting the provider cache — mainly useful in
    tests that construct many short-lived ModelSpecs with reused identities."""
    _provider_cache.clear()
