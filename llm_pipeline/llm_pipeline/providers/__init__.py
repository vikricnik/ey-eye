"""
Provider abstraction layer — see base.py for the core Protocol/types,
registry.py for the factory, resilience.py for timeout/retry/circuit-breaker,
and one module per backend (ollama.py, openai.py, anthropic.py, gemini.py,
copilot.py).

This __init__ re-exports the public surface so existing call sites can keep
writing `from llm_pipeline.providers import ModelSpec, get_provider, ...`
without needing to know which submodule anything actually lives in — that's
an implementation detail. Reach into the submodules directly only if you
need something not re-exported here (e.g. a specific adapter class for a
type check).
"""

from llm_pipeline.providers.base import (
    Generation,
    LLMProvider,
    ModelSpec,
    OllamaOptions,
    ProviderError,
    ProviderType,
    Usage,
)
from llm_pipeline.providers.registry import clear_provider_cache, get_provider
from llm_pipeline.providers.resilience import (
    CircuitBreaker,
    generate_with_retry,
    generate_with_timeout,
    reset_circuit_breaker,
)

__all__ = [
    "CircuitBreaker",
    "Generation",
    "LLMProvider",
    "ModelSpec",
    "OllamaOptions",
    "ProviderError",
    "ProviderType",
    "Usage",
    "clear_provider_cache",
    "generate_with_retry",
    "generate_with_timeout",
    "get_provider",
    "reset_circuit_breaker",
]
