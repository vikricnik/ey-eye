"""
Provider factory.

Adding a new provider: add a value to ProviderType (base.py), write an
adapter module implementing LLMProvider (see ollama.py for the simplest
example), then add one branch here. Nothing else in the pipeline needs to
change — every consumer only ever depends on the LLMProvider Protocol.
"""

from llm_pipeline.providers.base import ModelSpec, LLMProvider, ProviderType
from llm_pipeline.providers.ollama import OllamaProvider
from llm_pipeline.providers.openai import OpenAIProvider
from llm_pipeline.providers.anthropic import AnthropicProvider
from llm_pipeline.providers.gemini import GeminiProvider
from llm_pipeline.providers.copilot import CopilotProvider

# Providers are cheap-ish to reuse and somewhat wasteful to reconstruct per-request,
# so we cache one instance per unique (provider, model, temperature) combination.
_provider_cache: dict[str, LLMProvider] = {}


def get_provider(spec: ModelSpec) -> LLMProvider:
    """Factory: returns a cached provider instance for the given spec."""
    cache_key = f"{spec.identity}:{spec.temperature}"
    if cache_key in _provider_cache:
        return _provider_cache[cache_key]

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
    return provider


def clear_provider_cache() -> None:
    """Public accessor for resetting the provider cache — mainly useful in
    tests that construct many short-lived ModelSpecs with reused identities."""
    _provider_cache.clear()
