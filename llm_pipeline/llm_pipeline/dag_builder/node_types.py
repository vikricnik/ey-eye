"""
Node-type registry.

Today only `llm_call` is implemented, but this is the extension point for
the node types flagged as deliberately deferred (retrieval, tool,
human_approval): adding one means writing a new `build_..._node()` function
matching the NodeBuilder shape below and registering it in NODE_BUILDERS.
graph.py's assembly logic never needs to change — it only ever calls
build_node() and doesn't know or care how many types exist.
"""

import logging
import time
from collections.abc import Awaitable, Callable

from llm_pipeline.pipeline_config import NodeConfig, ExecutionConfig
from llm_pipeline.providers import ModelSpec, get_provider, generate_with_retry, ProviderError
from llm_pipeline.providers.resilience import CircuitBreaker
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.state import PipelineState, NodeResult
from llm_pipeline.dag_builder.templating import render_template

logger: logging.Logger = logging.getLogger("llm_pipeline")

# Every LangGraph node callable used in this package fits one of these two
# shapes: an async function producing a partial node_outputs update, or a
# synchronous routing function returning a plain string key (see branches.py
# / loops.py for where RouterCallable is used).
NodeCallable = Callable[[PipelineState], Awaitable[dict[str, dict[str, NodeResult]]]]
RouterCallable = Callable[[PipelineState], str]
LoopIncrementCallable = Callable[[PipelineState], Awaitable[dict[str, dict[str, int]]]]

NodeBuilder = Callable[[NodeConfig, ExecutionConfig, "CircuitBreaker | None"], NodeCallable]


def build_llm_call_node(
    node_cfg: NodeConfig,
    execution: ExecutionConfig,
    circuit_breaker: CircuitBreaker | None = None,
) -> NodeCallable:
    """The only node builder implemented today. Calls a single LLM per
    invocation, rendering its prompt_template against the current state."""
    if node_cfg.type != "llm_call":
        raise ValueError(f"Unsupported node type: {node_cfg.type}")

    assert node_cfg.model is not None  # enforced by NodeConfig's validator
    spec = ModelSpec(node_cfg.model.provider, node_cfg.model.model, node_cfg.model.temperature)

    async def node_fn(state: PipelineState) -> dict[str, dict[str, NodeResult]]:
        provider = get_provider(spec)
        prompt = render_template(
            node_cfg.prompt_template, state["node_outputs"], state["contextual_input"]
        )

        started_at = time.monotonic()
        try:
            answer = await generate_with_retry(
                provider,
                prompt,
                spec,
                execution.model_timeout_seconds,
                max_attempts=execution.max_retries + 1,
                backoff_base_seconds=execution.retry_backoff_seconds,
                circuit_breaker=circuit_breaker,
            )
        except ProviderError as e:
            logger.warning(f"[node:{node_cfg.id}] {spec.identity} failed: {e}")
            raise PipelineExecutionError(f"Node '{node_cfg.id}' failed: {e}") from e

        duration_ms = (time.monotonic() - started_at) * 1000

        result: NodeResult = {
            "node_id": node_cfg.id,
            "model_name": spec.identity,
            "output": answer,
            "duration_ms": duration_ms,
        }
        logger.info(f"[node:{node_cfg.id}] model={spec.identity} duration_ms={duration_ms:.0f}")
        return {"node_outputs": {node_cfg.id: result}}

    return node_fn


NODE_BUILDERS: dict[str, NodeBuilder] = {
    "llm_call": build_llm_call_node,
    # "retrieval": build_retrieval_node,      # future
    # "tool": build_tool_node,                 # future
    # "human_approval": build_approval_node,    # future
}


def build_node(
    node_cfg: NodeConfig,
    execution: ExecutionConfig,
    circuit_breaker: CircuitBreaker | None = None,
) -> NodeCallable:
    """Dispatches to the registered builder for node_cfg.type. This is the
    one place that grows when a new node type is added — graph.py just
    calls this function and never branches on type itself."""
    builder = NODE_BUILDERS.get(node_cfg.type)
    if builder is None:
        raise ValueError(
            f"Unknown node type: {node_cfg.type!r} (registered: {list(NODE_BUILDERS)})"
        )
    return builder(node_cfg, execution, circuit_breaker)
