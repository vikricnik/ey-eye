"""
Provider abstraction layer.

Every LLM backend (Ollama, OpenAI, Anthropic, Gemini, ...) is wrapped behind the
same `LLMProvider` Protocol so the rest of the pipeline (nodes.py) never needs to
know which backend it's talking to — it just calls `await provider.generate(prompt)`
and gets a plain string back.

To add a new provider:
  1. Add a value to `ProviderType`.
  2. Write an adapter class with an async `generate(self, prompt: str) -> str` method.
  3. Add a branch in `get_provider()`'s factory.
  4. Reference it from model_registry.py via a `ModelSpec(ProviderType.YOUR_NEW_ONE, "model-name")`.

Adapters use lazy imports so installing this package doesn't require every
provider's SDK — only the ones you actually configure in model_registry.py.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable
import asyncio

from llm_pipeline.settings import settings


class ProviderType(str, Enum):
    OLLAMA = "ollama"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"
    COPILOT = "copilot"


@dataclass(frozen=True)
class ModelSpec:
    """Identifies one specific model from one specific provider."""

    provider: ProviderType
    model: str
    temperature: float = 0.2

    @property
    def identity(self) -> str:
        """Human-readable id used throughout API responses, e.g. 'ollama:qwen3-coder:30b'."""
        return f"{self.provider.value}:{self.model}"


@runtime_checkable
class LLMProvider(Protocol):
    """The only interface nodes.py depends on. Any backend implementing this
    (regardless of its native SDK's shape) can be dropped into the pipeline."""

    async def generate(self, prompt: str) -> str: ...


class OllamaProvider:
    def __init__(self, spec: ModelSpec) -> None:
        from langchain_ollama import OllamaLLM

        self._llm = OllamaLLM(
            model=spec.model, temperature=spec.temperature, base_url=settings.ollama_base_url
        )

    async def generate(self, prompt: str) -> str:
        result: str = await self._llm.ainvoke(prompt)
        return result


class OpenAIProvider:
    def __init__(self, spec: ModelSpec) -> None:
        from langchain_openai import ChatOpenAI

        self._llm = ChatOpenAI(model=spec.model, temperature=spec.temperature)

    async def generate(self, prompt: str) -> str:
        result = await self._llm.ainvoke(prompt)
        return str(result.content)


class AnthropicProvider:
    def __init__(self, spec: ModelSpec) -> None:
        from langchain_anthropic import ChatAnthropic

        self._llm = ChatAnthropic(model=spec.model, temperature=spec.temperature)

    async def generate(self, prompt: str) -> str:
        result = await self._llm.ainvoke(prompt)
        return str(result.content)


class GeminiProvider:
    def __init__(self, spec: ModelSpec) -> None:
        from langchain_google_genai import ChatGoogleGenerativeAI

        self._llm = ChatGoogleGenerativeAI(model=spec.model, temperature=spec.temperature)

    async def generate(self, prompt: str) -> str:
        result = await self._llm.ainvoke(prompt)
        return str(result.content)


class CopilotProvider:
    """Placeholder adapter.

    GitHub Copilot doesn't expose a general-purpose public chat/completion API in
    the same shape as the others — it's IDE-integrated and code-completion focused
    (via the Copilot extension protocol / LSP, not a REST chat endpoint). If your
    organization has access to a Copilot-compatible enterprise endpoint, implement
    `generate()` here to call it. Left as a stub so the ProviderType enum and
    model_registry.py can reference it without breaking anything today.
    """

    def __init__(self, spec: ModelSpec) -> None:
        self._spec = spec

    async def generate(self, prompt: str) -> str:
        raise NotImplementedError(
            "CopilotProvider is a placeholder — no public general-purpose completion "
            "API exists for Copilot today. Implement generate() if you have access to "
            "a compatible endpoint."
        )


# Providers are cheap-ish to reuse and somewhat wasteful to reconstruct per-request,
# so we cache one instance per unique (provider, model, temperature) combination.
_provider_cache: dict[str, LLMProvider] = {}


class ProviderError(Exception):
    """Normalizes any provider failure (timeout, API error, connection refused, ...)
    into one exception type carrying the model's identity, so callers can catch a
    single type regardless of which backend or SDK raised the original error."""

    def __init__(self, model_identity: str, original: BaseException) -> None:
        self.model_identity = model_identity
        self.original = original
        super().__init__(f"{model_identity} failed: {original}")


async def generate_with_timeout(
    provider: LLMProvider, prompt: str, spec: ModelSpec, timeout_seconds: float
) -> str:
    """Runs provider.generate() with a hard timeout, raising ProviderError on either
    a timeout or any other failure. Centralizing this here means nodes.py never has
    to know the difference between "OpenAI raised an API error" and "Ollama hung" —
    it just catches ProviderError."""
    try:
        return await asyncio.wait_for(provider.generate(prompt), timeout=timeout_seconds)
    except asyncio.TimeoutError as e:
        raise ProviderError(spec.identity, e) from e
    except Exception as e:
        raise ProviderError(spec.identity, e) from e


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
