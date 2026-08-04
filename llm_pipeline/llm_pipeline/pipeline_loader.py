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

import re
from pathlib import Path

from fastapi import Request
from langgraph.graph.state import CompiledStateGraph

from llm_pipeline.pipeline_config import PipelineDefinition, load_pipeline_definition
from llm_pipeline.providers.resilience import CircuitBreaker
from llm_pipeline.dag_builder import build_graph
from llm_pipeline.errors import PipelineNotFoundError

# Only safe filename characters — pipeline_name comes straight from client
# input and is used to build a filesystem path, so this closes off any
# path-traversal attempt (e.g. "../../etc/passwd") before it reaches disk.
_SAFE_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]+$")


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
    ) -> None:
        self.pipelines_dir = pipelines_dir
        self.circuit_breaker = circuit_breaker or CircuitBreaker(failure_threshold, cooldown_seconds)
        self._cache: dict[str, tuple[PipelineDefinition, CompiledStateGraph]] = {}

    def get(self, name: str) -> tuple[PipelineDefinition, CompiledStateGraph]:
        if not _SAFE_NAME_PATTERN.match(name):
            raise PipelineNotFoundError(name)

        if name in self._cache:
            return self._cache[name]

        yaml_path = self.pipelines_dir / f"{name}.yaml"
        if not yaml_path.is_file():
            raise PipelineNotFoundError(name)

        definition = load_pipeline_definition(yaml_path)
        graph = build_graph(definition, circuit_breaker=self.circuit_breaker)
        self._cache[name] = (definition, graph)
        return definition, graph

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
