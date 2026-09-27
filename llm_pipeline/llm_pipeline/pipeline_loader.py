"""
Pipeline loading and caching.

PipelineCache replaces what used to be a bare module-level dict
(`_pipeline_cache`) plus a bare module-level CircuitBreaker singleton in
providers/resilience.py. Bundling both into one explicitly-constructed
object, injected via app.state (see get_pipeline_cache below) rather than
imported as globals, is what actually fixes the root cause of the
cross-test circuit-breaker contamination bug found earlier — not just the
symptom (an autouse fixture resetting a global between tests), but the
architecture that made that bug possible in the first place: multiple
PipelineCache instances (e.g. in different tests, or in principle different
app instances in the same process) now have fully independent state with
no shared global to leak through.
"""

from pathlib import Path

from fastapi import Request
from langgraph.graph.state import CompiledStateGraph

from llm_pipeline.dag_builder import build_graph
from llm_pipeline.dag_builder.node_types import ContextProbe, NodeServices, ProviderFactory
from llm_pipeline.errors import PipelineNotFoundError
from llm_pipeline.pipeline_config import (
    PipelineDefinition,
    is_safe_name,
    load_pipeline_definition,
)
from llm_pipeline.providers.resilience import CircuitBreaker

# (mtime_ns, size) of the file a cache entry was built from.
_FileStamp = tuple[int, int]


class PipelineCache:
    """Loads, compiles, and caches pipelines by name. Stateless across
    *processes* by design (every worker independently loads the same YAML
    files from the same disk on first request for a given name — see the
    project README for why there's deliberately no shared "active pipeline"
    to keep in sync across uvicorn workers) but stateful *within* one
    instance, which is exactly the scope a compiled-graph cache should have.

    Owns its own CircuitBreaker rather than sharing providers/resilience.py's
    process-wide default — every llm_call node built through this cache's
    compiled graphs gets that same instance, so circuit-breaker state is
    scoped to (and torn down with) this cache, not leaked globally.
    """

    def __init__(
        self,
        pipelines_dir: Path,
        circuit_breaker: CircuitBreaker | None = None,
        failure_threshold: int = 3,
        cooldown_seconds: float = 30.0,
        context_probe: ContextProbe | None = None,
        provider_factory: ProviderFactory | None = None,
    ) -> None:
        self.pipelines_dir = pipelines_dir
        self.circuit_breaker = circuit_breaker or CircuitBreaker(
            failure_threshold, cooldown_seconds
        )
        # Handed to every node this cache builds (see node_types.ContextProbe).
        self.context_probe = context_probe
        self._provider_factory = provider_factory
        self._cache: dict[str, tuple[_FileStamp, PipelineDefinition, CompiledStateGraph]] = {}

    def get(self, name: str) -> tuple[PipelineDefinition, CompiledStateGraph]:
        """Returns the compiled pipeline, rebuilding it whenever the file on
        disk has changed since it was cached (checked by mtime + size — one
        stat() per call). That keeps every worker process current after an
        editor saves through ANY of them, and applies hand edits without a
        restart."""
        if not is_safe_name(name):
            raise PipelineNotFoundError(name)

        yaml_path = self.pipelines_dir / f"{name}.yaml"
        try:
            stat = yaml_path.stat()
        except FileNotFoundError:
            self._cache.pop(name, None)
            raise PipelineNotFoundError(name) from None
        stamp: _FileStamp = (stat.st_mtime_ns, stat.st_size)

        cached = self._cache.get(name)
        if cached is not None and cached[0] == stamp:
            return cached[1], cached[2]

        definition = load_pipeline_definition(yaml_path)
        graph = build_graph(definition, self.node_services)
        self._cache[name] = (stamp, definition, graph)
        return definition, graph

    @property
    def node_services(self) -> NodeServices:
        """What the graphs this cache builds call out to: its own circuit
        breaker and context probe, and its provider factory (None: the
        provider registry — see NodeServices)."""
        return NodeServices(
            provider_factory=self._provider_factory,
            circuit_breaker=self.circuit_breaker,
            context_probe=self.context_probe,
        )

    def invalidate(self, name: str) -> None:
        """Drops one pipeline's compiled graph — called right after a save,
        so the next request rebuilds it even if the new file happens to
        share the old one's mtime and size."""
        self._cache.pop(name, None)

    def clear(self) -> None:
        """Clears cached compiled graphs AND resets circuit-breaker state —
        a full reset of this cache's scope. Used by tests between runs."""
        self._cache.clear()
        self.circuit_breaker.reset()


def get_pipeline_cache(request: Request) -> PipelineCache:
    """FastAPI dependency: retrieves the PipelineCache instance stored on
    app.state (set once at app creation — see main.py) rather than reaching
    for a module-level global. Endpoints depend on this instead of calling
    a bare `get_pipeline()` function, which is what makes the cache
    genuinely swappable/injectable (e.g. a test could construct its own
    FastAPI app with a different PipelineCache on app.state) rather than
    hardwired to one specific global object."""
    cache: PipelineCache = request.app.state.pipeline_cache
    return cache
