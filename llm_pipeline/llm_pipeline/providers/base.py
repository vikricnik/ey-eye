"""
Base types every provider adapter and consumer depends on.

Kept dependency-free (no adapter imports here) so adapters can each import
this module without any risk of circularity, and so consumers that only
need the *types* (e.g. pipeline_config.py, which references ModelSpec in
its schema) don't pull in every adapter's lazy SDK import machinery.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Protocol, runtime_checkable


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
    """The only interface the rest of the pipeline depends on. Any backend
    implementing this (regardless of its native SDK's shape) can be dropped
    into the pipeline — see registry.py for how a ModelSpec becomes one of
    these, and the individual adapter modules (ollama.py, openai.py, ...)
    for how each backend is wrapped to satisfy it."""

    async def generate(self, prompt: str) -> str: ...


class ProviderError(Exception):
    """Normalizes any provider failure (timeout, API error, connection refused, ...)
    into one exception type carrying the model's identity, so callers can catch a
    single type regardless of which backend or SDK raised the original error."""

    def __init__(self, model_identity: str, original: BaseException) -> None:
        self.model_identity = model_identity
        self.original = original
        super().__init__(f"{model_identity} failed: {original}")
