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

import importlib
from typing import TYPE_CHECKING, Any

from llm_pipeline.providers.base import (
    Generation,
    LLMProvider,
    ModelSpec,
    OllamaOptions,
    ProviderError,
    ProviderType,
    Usage,
)

if TYPE_CHECKING:
    from llm_pipeline.providers.registry import clear_provider_cache, get_provider
    from llm_pipeline.providers.resilience import (
        CircuitBreaker,
        generate_with_retry,
        generate_with_timeout,
        reset_circuit_breaker,
    )

# The registry imports every adapter, and resilience reads the settings, so
# these load on first use (PEP 562) rather than with the package: importing
# just the types — as pipeline_config does, via providers.base, which runs
# this file first — must not pull in the whole provider layer.
_LOADED_ON_FIRST_USE = {
    "clear_provider_cache": "registry",
    "get_provider": "registry",
    "CircuitBreaker": "resilience",
    "generate_with_retry": "resilience",
    "generate_with_timeout": "resilience",
    "reset_circuit_breaker": "resilience",
}


def __dir__() -> list[str]:
    # The lazily loaded names too, for dir() and REPL completion.
    return sorted(set(globals()) | set(__all__))


def __getattr__(name: str) -> Any:
    submodule = _LOADED_ON_FIRST_USE.get(name)
    if submodule is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    return getattr(importlib.import_module(f"{__name__}.{submodule}"), name)


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
