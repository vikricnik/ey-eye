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
from collections.abc import Awaitable, Callable, Hashable
from typing import Any, Protocol

from jinja2 import UndefinedError
from langgraph.types import StreamWriter

from llm_pipeline.dag_builder.labels import match_label
from llm_pipeline.dag_builder.reasoning import strip_reasoning
from llm_pipeline.dag_builder.templating import render_template
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.pipeline_config import NodeConfig, PipelineDefinition
from llm_pipeline.pipeline_config.effective import EffectiveNode, effective_node
from llm_pipeline.pipeline_config.schema import DEFAULT_TEMPERATURE
from llm_pipeline.providers import (
    ModelSpec,
    ProviderError,
    ProviderType,
    generate_with_retry,
    get_provider,
)
from llm_pipeline.providers.resilience import CircuitBreaker
from llm_pipeline.state import NodeResult, PipelineState

logger: logging.Logger = logging.getLogger("llm_pipeline")

# Every LangGraph node callable used in this package fits one of these two
# shapes: an async function producing a partial node_outputs update, or a
# synchronous routing function returning the path-map key(s) to follow — a
# list when a branch route starts several nodes (see branches.py / loops.py
# for where RouterCallable is used).
NodeCallable = Callable[[PipelineState], Awaitable[dict[str, dict[str, NodeResult]]]]
RouterCallable = Callable[[PipelineState], Hashable | list[Hashable]]
LoopIncrementCallable = Callable[[PipelineState], Awaitable[dict[str, dict[str, int]]]]

# Ollama model name -> the context size (tokens) the loaded model is running
# with right now; None when unknown. Asked right after a node's call, while
# the model is still loaded as that call loaded it — see
# ModelCatalog.running_context, which main.py injects through PipelineCache.
ContextProbe = Callable[[str], Awaitable[int | None]]


class NodeBuilder(Protocol):
    """Builders get the whole definition, not just the node: a node's
    effective settings depend on the pipeline's defaults and execution
    config."""

    def __call__(
        self,
        node_cfg: NodeConfig,
        definition: PipelineDefinition,
        circuit_breaker: CircuitBreaker | None = None,
        context_probe: ContextProbe | None = None,
    ) -> NodeCallable: ...


# The `custom` stream-mode payload a node emits the moment it actually
# starts work (and again, with a higher `attempt`, before each retry) —
# routers/ask.py turns it into a `node_start` SSE event. This is what lets
# clients show a node as running from a real server signal rather than
# guessing from the graph shape.
NODE_START_EVENT = "node_start"


def _no_stream(_chunk: Any) -> None:
    """Default writer when a node is called outside a streaming graph run
    (e.g. directly in a test). LangGraph injects the real writer by
    parameter name and annotation, and supplies its own no-op when the
    caller didn't request stream_mode="custom"."""


def render_node_prompt(node_cfg: NodeConfig, effective: EffectiveNode, state: PipelineState) -> str:
    """The prompt a node sends: its template rendered with the run's input
    and the other nodes' outputs so far. Previews render it the same way."""
    # A node that doesn't see history gets just the new message.
    sees_history = effective.include_history
    return render_template(
        node_cfg.prompt_template,
        state["node_outputs"],
        state["contextual_input"] if sees_history else state["input"],
        question=state["input"],
        # .get: callers that build the state by hand may leave it out.
        history=state.get("history", "") if sees_history else "",
    )


def build_llm_call_node(
    node_cfg: NodeConfig,
    definition: PipelineDefinition,
    circuit_breaker: CircuitBreaker | None = None,
    context_probe: ContextProbe | None = None,
) -> NodeCallable:
    """The only node builder implemented today. Calls a single LLM per
    invocation, rendering its prompt_template against the current state,
    with the pipeline's defaults applied (see pipeline_config/effective.py)."""
    if node_cfg.type != "llm_call":
        raise ValueError(f"Unsupported node type: {node_cfg.type}")

    execution = definition.execution
    effective = effective_node(definition, node_cfg)
    model = effective.model
    spec = ModelSpec(
        model.provider,
        model.model,
        model.temperature if model.temperature is not None else DEFAULT_TEMPERATURE,
        model.options,
    )

    async def node_fn(
        state: PipelineState, writer: StreamWriter = _no_stream
    ) -> dict[str, dict[str, NodeResult]]:
        try:
            prompt = render_node_prompt(node_cfg, effective, state)
        except UndefinedError as e:
            # Validation guarantees every reference is a real dependency, so
            # this is one that didn't run on this path (another branch
            # route, or a loop's first pass).
            raise PipelineExecutionError(
                f"Node '{node_cfg.id}': its prompt uses output that isn't available on "
                f"this run ({e.message}) — wrap it in {{% if <node> is defined %}}",
                node_id=node_cfg.id,
            ) from e
        replay = state.get("replay") or {}
        # A re-run reuses this node's previous output — on its first
        # execution only: a loop sending the run back here runs it for real.
        replaying = node_cfg.id in replay and node_cfg.id not in state["node_outputs"]

        def announce_start(attempt: int) -> None:
            # Carries exactly what the model is about to receive — the
            # rendered prompt (other nodes' outputs filled in) and the system
            # prompt — so clients can show each node's incoming messages.
            writer(
                {
                    "event": NODE_START_EVENT,
                    "node_id": node_cfg.id,
                    "model_name": spec.identity,
                    "attempt": attempt,
                    "prompt": prompt,
                    "system": effective.system_prompt,
                    "replayed": replaying,
                }
            )

        announce_start(1)
        if replaying:
            return {
                "node_outputs": {
                    node_cfg.id: {
                        "node_id": node_cfg.id,
                        "model_name": spec.identity,
                        "output": replay[node_cfg.id],
                        "duration_ms": 0.0,
                        "replayed": True,
                    }
                }
            }
        provider = get_provider(spec)

        started_at = time.monotonic()
        try:
            generation = await generate_with_retry(
                provider,
                prompt,
                spec,
                execution.model_timeout_seconds,
                max_attempts=execution.max_retries + 1,
                backoff_base_seconds=execution.retry_backoff_seconds,
                circuit_breaker=circuit_breaker,
                system=effective.system_prompt,
                # A retry restarts the model's output from scratch, so it is
                # announced as a fresh start of this node.
                on_retry=announce_start,
            )
        except ProviderError as e:
            logger.warning(f"[node:{node_cfg.id}] {spec.identity} failed: {e}")
            raise PipelineExecutionError(
                f"Node '{node_cfg.id}' failed: {e}", node_id=node_cfg.id
            ) from e

        duration_ms = (time.monotonic() - started_at) * 1000
        answer = generation.text
        if effective.strip_reasoning:
            answer = strip_reasoning(answer)
        if node_cfg.labels is not None:
            label = match_label(answer, node_cfg.labels)
            if label is None:
                raise PipelineExecutionError(
                    f"Node '{node_cfg.id}' answered {answer[:200]!r}, which names none of "
                    f"its labels ({', '.join(node_cfg.labels)}) — or more than one",
                    node_id=node_cfg.id,
                )
            answer = label

        result: NodeResult = {
            "node_id": node_cfg.id,
            "model_name": spec.identity,
            "output": answer,
            "duration_ms": duration_ms,
        }
        if generation.usage is not None:
            context = model.options.num_ctx if model.options else None
            if (
                context is None
                and context_probe is not None
                and spec.provider == ProviderType.OLLAMA
            ):
                context = await context_probe(spec.model)
            result["usage"] = {
                "prompt_tokens": generation.usage.prompt_tokens,
                "completion_tokens": generation.usage.completion_tokens,
                "generation_ms": generation.usage.generation_ms,
                "context_window": context,
                # Ollama counts tokens AFTER cutting a prompt that didn't
                # fit, so clients also compare the length that was sent.
                "prompt_chars": len(prompt) + len(effective.system_prompt or ""),
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
    definition: PipelineDefinition,
    circuit_breaker: CircuitBreaker | None = None,
    context_probe: ContextProbe | None = None,
) -> NodeCallable:
    """Dispatches to the registered builder for node_cfg.type. This is the
    one place that grows when a new node type is added — graph.py just
    calls this function and never branches on type itself."""
    builder = NODE_BUILDERS.get(node_cfg.type)
    if builder is None:
        raise ValueError(
            f"Unknown node type: {node_cfg.type!r} (registered: {list(NODE_BUILDERS)})"
        )
    return builder(node_cfg, definition, circuit_breaker, context_probe)
