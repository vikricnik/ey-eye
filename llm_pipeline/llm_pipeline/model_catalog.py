"""
Which models an editor client may select — and the allowlist check every
client-submitted pipeline or preset goes through before it is saved.

Model identities that reach the server from a client are never trusted on
their own (constitution principle V). A client may only pick from what the
server itself vouches for:

  - Ollama: any model actually installed on the configured Ollama server,
    as reported by its /api/tags endpoint.
  - Cloud providers: only identities listed in EDITOR_CLOUD_MODELS.

The check fails closed: if Ollama can't be reached, an Ollama model can't be
verified, so the save is refused rather than waved through. The one
exception is a model a pipeline ALREADY uses in its stored version — that
identity was already on the server, so re-saving it (e.g. after editing
only a prompt) is not new client input.

Constructed once in main.py's lifespan and injected via app.state, like
PipelineCache — no module-level instance.
"""

import logging
import time
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass, field
from typing import NamedTuple

from fastapi import Request

from llm_pipeline.pipeline_config import NodeModelConfig
from llm_pipeline.providers import ProviderType

logger: logging.Logger = logging.getLogger("llm_pipeline")


@dataclass(frozen=True)
class CatalogModel:
    name: str
    size_bytes: int | None = None
    parameter_size: str | None = None
    quantization: str | None = None
    family: str | None = None


@dataclass(frozen=True)
class ProviderCatalog:
    provider: str
    reachable: bool
    models: list[CatalogModel] = field(default_factory=list[CatalogModel])
    error: str | None = None


class ModelNotAllowedError(Exception):
    """A client-submitted definition names a model the server doesn't vouch
    for. `node_id` names the offending node when there is one."""

    def __init__(self, message: str, node_id: str | None = None) -> None:
        super().__init__(message)
        self.node_id = node_id


@dataclass(frozen=True)
class ModelLimits:
    """What Ollama reports about one installed model."""

    name: str
    context_length: int | None = None
    parameter_size: str | None = None
    quantization: str | None = None
    family: str | None = None


class LimitWarning(NamedTuple):
    """A setting beyond what a model supports — advisory, never blocking."""

    node_id: str | None  # the node an editor should highlight, if any
    message: str


class ModelUse(NamedTuple):
    """One place a definition calls a model, for allowlist checks and hints."""

    node_id: str | None  # the node an editor should highlight, if any
    model: NodeModelConfig
    where: str  # how messages name it: "node 'x'", "pipeline default model", …


# How the catalog asks Ollama — replaceable, so tests need no Ollama server.
# Installed models (/api/tags).
OllamaModelsFetcher = Callable[[], Awaitable[list[CatalogModel]]]
# One installed model's details (/api/show).
OllamaModelDetailsFetcher = Callable[[str], Awaitable[ModelLimits]]
# Loaded models -> the context size each is running with (/api/ps).
OllamaRunningModelsFetcher = Callable[[], Awaitable[dict[str, int]]]
# Loaded models barely change between calls in one run; a snapshot this
# fresh is reused, and a model missing from it triggers a refetch anyway.
_RUNNING_TTL_SECONDS = 5.0


def _normalize_ollama_name(name: str) -> str:
    """Ollama resolves a bare name to its `:latest` tag, so `llama3` and
    `llama3:latest` are the same installed model."""
    return name if ":" in name else f"{name}:latest"


def model_identity(model: NodeModelConfig) -> str:
    return f"{model.provider.value}:{model.name}"


class ModelCatalog:
    def __init__(
        self,
        ollama_base_url: str,
        cloud_models: Iterable[str],
        ttl_seconds: float = 30.0,
        fetch_ollama_models: OllamaModelsFetcher | None = None,
        fetch_ollama_model_details: OllamaModelDetailsFetcher | None = None,
        fetch_running_ollama_models: OllamaRunningModelsFetcher | None = None,
    ) -> None:
        self.ollama_base_url = ollama_base_url
        self.cloud_models = sorted(set(cloud_models))
        self.ttl_seconds = ttl_seconds
        self._fetch_ollama_models = fetch_ollama_models or self._ollama_api_tags
        self._fetch_ollama_model_details = fetch_ollama_model_details or self._ollama_api_show
        self._fetch_running_ollama_models = fetch_running_ollama_models or self._ollama_api_ps
        self._running: tuple[float, dict[str, int]] | None = None
        self._cached: tuple[float, ProviderCatalog] | None = None
        self._limits: dict[str, tuple[float, ModelLimits]] = {}

    async def _ollama_api_tags(self) -> list[CatalogModel]:
        from ollama import AsyncClient

        response = await AsyncClient(host=self.ollama_base_url).list()
        models: list[CatalogModel] = []
        for m in response.models:
            if not m.model:
                continue
            details = m.details
            models.append(
                CatalogModel(
                    name=m.model,
                    size_bytes=int(m.size) if m.size is not None else None,
                    parameter_size=details.parameter_size if details else None,
                    quantization=details.quantization_level if details else None,
                    family=details.family if details else None,
                )
            )
        return sorted(models, key=lambda model: model.name)

    async def _ollama_api_show(self, name: str) -> ModelLimits:
        from ollama import AsyncClient

        shown = await AsyncClient(host=self.ollama_base_url).show(name)
        info = dict(shown.modelinfo or {})
        architecture = info.get("general.architecture")
        context = info.get(f"{architecture}.context_length") if architecture else None
        details = shown.details
        return ModelLimits(
            name=name,
            context_length=context if isinstance(context, int) else None,
            parameter_size=details.parameter_size if details else None,
            quantization=details.quantization_level if details else None,
            family=details.family if details else None,
        )

    async def _ollama_api_ps(self) -> dict[str, int]:
        from ollama import AsyncClient

        response = await AsyncClient(host=self.ollama_base_url).ps()
        running: dict[str, int] = {}
        for m in response.models:
            # Newer Ollama versions report it; older ones don't.
            context = getattr(m, "context_length", None)
            if m.model and isinstance(context, int):
                running[_normalize_ollama_name(m.model)] = context
        return running

    async def running_context(self, name: str) -> int | None:
        """The context size (tokens) a loaded Ollama model is running with —
        what prompts to it are cut to when a node sets no num_ctx. Ollama
        silently drops the start of a longer prompt, so clients compare
        this with the prompt's token count. None when the model isn't
        loaded, Ollama doesn't report it, or can't be reached."""
        key = _normalize_ollama_name(name)
        now = time.monotonic()
        snapshot = self._running
        if snapshot is None or now - snapshot[0] > _RUNNING_TTL_SECONDS or key not in snapshot[1]:
            try:
                snapshot = (now, await self._fetch_running_ollama_models())
            except Exception as e:
                logger.info(f"model catalog: can't list loaded Ollama models: {e}")
                return None
            self._running = snapshot
        return snapshot[1].get(key)

    async def limits(self, name: str) -> ModelLimits | None:
        """An Ollama model's limits (max context, size), cached like the
        model list. None when the model isn't installed or Ollama can't be
        reached — hints are best-effort and never block anything."""
        now = time.monotonic()
        cached = self._limits.get(name)
        if cached and now - cached[0] < self.ttl_seconds:
            return cached[1]
        try:
            found = await self._fetch_ollama_model_details(name)
        except Exception as e:
            logger.info(f"model catalog: no details for Ollama model '{name}': {e}")
            return None
        self._limits[name] = (now, found)
        return found

    async def limit_warnings(self, models: Iterable[ModelUse]) -> list[LimitWarning]:
        """Settings that exceed what a model supports — currently a
        `num_ctx` above the model's maximum context length. Warnings, not
        errors: Ollama accepts the value, but the model wasn't trained for it."""
        warnings: list[LimitWarning] = []
        for node_id, model, where in models:
            num_ctx = model.options.num_ctx if model.options else None
            if model.provider != ProviderType.OLLAMA or num_ctx is None:
                continue
            found = await self.limits(model.name)
            if found and found.context_length and num_ctx > found.context_length:
                warnings.append(
                    LimitWarning(
                        node_id,
                        f"{where}: num_ctx {num_ctx:,} exceeds {model.name}'s maximum context "
                        f"of {found.context_length:,} tokens",
                    )
                )
        return warnings

    async def list_ollama_models(self, refresh: bool = False) -> ProviderCatalog:
        """Installed Ollama models, cached for `ttl_seconds`. Never raises:
        an unreachable server is reported as `reachable=False`."""
        now = time.monotonic()
        if not refresh and self._cached and now - self._cached[0] < self.ttl_seconds:
            return self._cached[1]
        try:
            catalog = ProviderCatalog(
                provider=ProviderType.OLLAMA.value,
                reachable=True,
                models=await self._fetch_ollama_models(),
            )
        except Exception as e:
            logger.warning(f"model catalog: Ollama at {self.ollama_base_url} unreachable: {e}")
            # Don't cache failures: the next request retries immediately.
            return ProviderCatalog(
                provider=ProviderType.OLLAMA.value,
                reachable=False,
                error=f"Ollama server unreachable at {self.ollama_base_url}",
            )
        self._cached = (now, catalog)
        return catalog

    async def providers(self, refresh: bool = False) -> list[ProviderCatalog]:
        catalogs = [await self.list_ollama_models(refresh=refresh)]
        by_provider: dict[str, list[CatalogModel]] = {}
        for identity in self.cloud_models:
            provider, _, model = identity.partition(":")
            by_provider.setdefault(provider, []).append(CatalogModel(name=model))
        for provider, models in sorted(by_provider.items()):
            catalogs.append(ProviderCatalog(provider=provider, reachable=True, models=models))
        return catalogs

    async def find_disallowed(
        self,
        models: Iterable[ModelUse],
        already_stored: set[str] | None = None,
    ) -> list[ModelNotAllowedError]:
        """Every model in `models` that isn't on the allowlist — reported,
        not raised (see ensure_allowed). `models`
        pairs each model block with the node id it belongs to (None for a
        preset). `already_stored` holds the model identities the stored
        version already uses — see module docstring."""
        stored = already_stored or set()
        found: list[ModelNotAllowedError] = []
        ollama: ProviderCatalog | None = None
        for node_id, model, where in models:
            identity = model_identity(model)
            if identity in stored:
                continue
            if model.provider == ProviderType.OLLAMA:
                if ollama is None:
                    ollama = await self.list_ollama_models()
                if not ollama.reachable:
                    found.append(
                        ModelNotAllowedError(
                            f"{where}: can't verify Ollama model '{model.name}' — "
                            f"{ollama.error}. Only installed models can be selected.",
                            node_id,
                        )
                    )
                    continue
                installed = {_normalize_ollama_name(m.name) for m in ollama.models}
                if _normalize_ollama_name(model.name) not in installed:
                    found.append(
                        ModelNotAllowedError(
                            f"{where}: Ollama model '{model.name}' is not installed on "
                            f"{self.ollama_base_url} (run `ollama pull {model.name}` first)",
                            node_id,
                        )
                    )
            elif identity not in self.cloud_models:
                found.append(
                    ModelNotAllowedError(
                        f"{where}: model '{identity}' is not in the server's "
                        f"EDITOR_CLOUD_MODELS allowlist",
                        node_id,
                    )
                )
        return found

    async def ensure_allowed(
        self,
        models: Iterable[ModelUse],
        already_stored: set[str] | None = None,
    ) -> None:
        """Fail-closed gate used before any write: raises the first model
        find_disallowed() reports."""
        found = await self.find_disallowed(models, already_stored)
        if found:
            raise found[0]


def get_model_catalog(request: Request) -> ModelCatalog:
    """FastAPI dependency: the app's ModelCatalog (set in main.py's lifespan)."""
    catalog: ModelCatalog = request.app.state.model_catalog
    return catalog
