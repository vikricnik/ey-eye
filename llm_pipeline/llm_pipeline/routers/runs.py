"""
Running a pipeline: POST /pipelines/{name}/runs — answered when the run
finishes, or streamed as Server-Sent Events while it runs when the client
prefers `text/event-stream` (see wants_event_stream).
"""

import logging
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import aclosing
from dataclasses import dataclass
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph
from pydantic import BaseModel

from llm_pipeline.api_error import ApiError
from llm_pipeline.api_schemas import (
    ErrorCode,
    LoopIterationEvent,
    NodeCompleteEvent,
    NodeOutput,
    NodeStartEvent,
    NodeTokenEvent,
    RunRequest,
    RunResponse,
    StreamDoneEvent,
)
from llm_pipeline.auth import require_api_key
from llm_pipeline.dag_builder.node_types import NODE_START_EVENT
from llm_pipeline.disconnects import cancel_on_disconnect, until_disconnected
from llm_pipeline.error_handling import ERROR_RESPONSES, build_error_response
from llm_pipeline.errors import PipelineExecutionError, PipelineNotFoundError
from llm_pipeline.history import Summarizer, prepare_input
from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.pipeline_config.effective import effective_model
from llm_pipeline.pipeline_config.schema import DEFAULT_TEMPERATURE
from llm_pipeline.pipeline_config.templates import render
from llm_pipeline.pipeline_loader import PipelineCache, get_pipeline_cache
from llm_pipeline.providers import ModelSpec, RetryPolicy, generate_with_retry, get_provider
from llm_pipeline.rate_limit import enforce_rate_limit
from llm_pipeline.rerun import replay_outputs
from llm_pipeline.settings import settings
from llm_pipeline.state import NodeResult, PipelineState

logger: logging.Logger = logging.getLogger("llm_pipeline")

router = APIRouter()


def _validate_prompt_and_history(run_request: RunRequest) -> None:
    if not run_request.prompt.strip():
        raise ApiError(ErrorCode.INPUT_INVALID, "prompt cannot be empty")

    if len(run_request.prompt) > settings.max_prompt_length:
        raise ApiError(
            ErrorCode.INPUT_TOO_LARGE,
            f"prompt exceeds max_prompt_length ({len(run_request.prompt)} > "
            f"{settings.max_prompt_length} characters)",
        )

    for i, turn in enumerate(run_request.history):
        if len(turn.prompt) > settings.max_history_turn_length:
            raise ApiError(
                ErrorCode.INPUT_TOO_LARGE,
                f"history[{i}].prompt exceeds max_history_turn_length",
            )
        if len(turn.final_answer) > settings.max_history_turn_length:
            raise ApiError(
                ErrorCode.INPUT_TOO_LARGE,
                f"history[{i}].final_answer exceeds max_history_turn_length",
            )
        for node_id, text in turn.outputs.items():
            if len(text) > settings.max_history_turn_length:
                raise ApiError(
                    ErrorCode.INPUT_TOO_LARGE,
                    f"history[{i}].outputs.{node_id} exceeds max_history_turn_length",
                )


def _summarizer(definition: PipelineDefinition, cache: PipelineCache) -> Summarizer | None:
    """The model call that condenses older turns, when the pipeline has
    `history.summarize` — same timeout, retries and circuit breaker as the
    pipeline's nodes."""
    config = definition.history.summarize
    if config is None:
        return None
    model = effective_model(config.model, None)
    assert model is not None
    spec = ModelSpec(
        model.provider,
        model.name,
        model.temperature if model.temperature is not None else DEFAULT_TEMPERATURE,
        model.options,
    )
    execution = definition.execution

    async def summarize(history: str) -> str:
        generation = await generate_with_retry(
            get_provider(spec),
            render(config.prompt, {"history": history}),
            spec,
            RetryPolicy.from_execution(execution),
            circuit_breaker=cache.circuit_breaker,
        )
        return generation.text

    return summarize


def _run_config(definition: PipelineDefinition) -> RunnableConfig:
    """LangGraph run config: the pipeline's parallelism limit, if any."""
    limit = definition.execution.max_concurrency
    return RunnableConfig(max_concurrency=limit) if limit is not None else RunnableConfig()


def _remembered(
    definition: PipelineDefinition, node_outputs: dict[str, NodeResult]
) -> dict[str, str]:
    """Outputs of the nodes in `history.remember` that ran, for the client
    to keep with this turn."""
    return {
        node_id: node_outputs[node_id]["output"]
        for node_id in definition.history.remember
        if node_id in node_outputs
    }


@dataclass(frozen=True)
class PreparedRun:
    """A run ready to start: the pipeline, compiled, and its first state."""

    definition: PipelineDefinition
    graph: CompiledStateGraph
    initial_state: PipelineState


async def prepare_run(name: str, run_request: RunRequest, cache: PipelineCache) -> PreparedRun:
    """Shared setup for a run, answered or streamed: validates the request,
    resolves pipeline `name`, and builds the initial LangGraph state. Every
    error raised here is an ApiError with the correct status and code —
    this always runs BEFORE any response has been sent (streaming or not),
    so raising here is always safe. Once a run starts actually streaming,
    that safety no longer holds — see pipeline_events' docstring."""
    _validate_prompt_and_history(run_request)

    try:
        definition, graph = cache.get(name)
    except PipelineNotFoundError as e:
        raise ApiError(ErrorCode.PIPELINE_NOT_FOUND, str(e)) from e

    replay = _replay(run_request, definition)
    prepared = await prepare_input(
        run_request.prompt, run_request.history, definition, _summarizer(definition, cache)
    )

    initial_state: PipelineState = {
        "input": prepared.question,
        "contextual_input": prepared.contextual,
        "history": prepared.history,
        "node_outputs": {},
        "loop_counts": {},
    }
    if replay:
        initial_state["replay"] = replay
    return PreparedRun(definition, graph, initial_state)


def _replay(run_request: RunRequest, definition: PipelineDefinition) -> dict[str, str]:
    """A re-run's reused outputs (see rerun.py) — empty for a normal run."""
    if run_request.rerun is None:
        return {}
    if not any(n.id == run_request.rerun.from_node for n in definition.nodes):
        raise ApiError(
            ErrorCode.NODE_NOT_FOUND,
            f"can't re-run from '{run_request.rerun.from_node}': "
            f"no such node in '{definition.name}'",
        )
    for node_id, text in run_request.rerun.outputs.items():
        if len(text) > settings.max_history_turn_length:
            raise ApiError(
                ErrorCode.INPUT_TOO_LARGE,
                f"rerun.outputs.{node_id} exceeds max_history_turn_length",
            )
    return replay_outputs(definition, run_request.rerun.from_node, run_request.rerun.outputs)


# An unexpected failure is a bug: its text stays in the server log (found
# by exceptionUID), not in the response.
UNEXPECTED_RUN_FAILURE = "Internal server error while running the pipeline"


def _failure_details(e: PipelineExecutionError) -> dict[str, object]:
    """Which node or loop a failed run is attributable to, when known — so
    a live-status client (the visual DAG graph) can mark that specific one
    instead of only knowing the run as a whole failed. See
    PipelineExecutionError's docstring and
    specs/001-visual-dag-graph/contracts/pipeline-detail-api.md."""
    if e.node_id is not None:
        return {"node_id": e.node_id}
    if e.loop_id is not None:
        return {"loop_id": e.loop_id}
    return {}


def node_dtos(node_outputs: dict[str, NodeResult]) -> dict[str, NodeOutput]:
    return {node_id: NodeOutput.model_validate(result) for node_id, result in node_outputs.items()}


def _resolve_output_node(
    definition: PipelineDefinition, node_outputs: dict[str, NodeResult]
) -> str | None:
    """output_nodes are CANDIDATES, not a single fixed id — once a branch
    means only one of several possible "final" nodes actually runs per
    request, the first candidate that ran wins."""
    for candidate in definition.output_nodes:
        if candidate in node_outputs:
            return candidate
    return None


async def run_pipeline(
    name: str, run_request: RunRequest, cache: PipelineCache, request: Request
) -> RunResponse:
    """One whole run, answered when it finishes — a run that isn't
    streamed, here or through the OpenAI-compatible endpoint. Stopped if the
    client disconnects (see disconnects.py). Raises ApiError."""
    run = await prepare_run(name, run_request, cache)
    definition = run.definition

    try:
        # graph.ainvoke's declared return type is generic (LangGraph doesn't
        # know about our specific PipelineState TypedDict) — cast makes
        # explicit what we already know: our own node functions and state
        # reducers guarantee this exact shape at runtime.
        final_state: PipelineState = cast(
            PipelineState,
            await cancel_on_disconnect(
                request, run.graph.ainvoke(run.initial_state, config=_run_config(definition))
            ),
        )
    except HTTPException:
        raise  # the client disconnected
    except PipelineExecutionError as e:
        logger.exception(f"Pipeline '{name}' run failed")
        raise ApiError(ErrorCode.PIPELINE_RUN_FAILED, str(e), details=_failure_details(e)) from e
    except Exception as e:
        logger.exception(f"Pipeline '{name}' run failed unexpectedly")
        raise ApiError(ErrorCode.INTERNAL_ERROR, UNEXPECTED_RUN_FAILURE) from e

    node_outputs = final_state["node_outputs"]
    resolved_output_node = _resolve_output_node(definition, node_outputs)

    if resolved_output_node is None:
        raise ApiError(
            ErrorCode.PIPELINE_RUN_FAILED,
            f"Pipeline completed but none of its output_nodes "
            f"({', '.join(definition.output_nodes)}) produced a result",
        )

    return RunResponse(
        pipeline_name=definition.name,
        output_node=resolved_output_node,
        final_answer=node_outputs[resolved_output_node]["output"],
        node_outputs=node_dtos(node_outputs),
        loop_iterations=final_state.get("loop_counts", {}),
        remembered=_remembered(definition, node_outputs),
    )


def sse_event(event_type: str, data: BaseModel) -> str:
    """Formats one Server-Sent Event. The blank line at the end is
    required by the SSE spec to terminate the event."""
    return f"event: {event_type}\ndata: {data.model_dump_json()}\n\n"


def extract_stream_part(step: object) -> tuple[str, dict[str, object]] | None:
    """Normalizes one value yielded by graph.astream() into a
    (stream_mode, payload) pair, or None if the shape isn't recognized.

    With several stream modes requested ("updates", "custom" and
    "messages"), LangGraph yields (mode_name, payload) tuples. A "messages"
    payload is itself a (message_chunk, metadata) tuple, returned here as
    {"message": ..., "metadata": ...}. A bare dict is still accepted and
    treated as an "updates" payload — that's the shape a single-mode
    astream() is documented to produce, and it has been observed to vary
    between versions. Pulled out as a standalone function so every shape is
    unit-tested directly — see tests/test_streaming.py — without mocking
    LangGraph's astream() itself."""
    if isinstance(step, dict):
        return "updates", cast(dict[str, object], step)
    if not (isinstance(step, tuple) and len(step) == 2 and isinstance(step[0], str)):
        return None
    mode, payload = step[0], step[1]
    if isinstance(payload, dict):
        return mode, cast(dict[str, object], payload)
    if (
        mode == "messages"
        and isinstance(payload, tuple)
        and len(payload) == 2
        and isinstance(payload[1], dict)
    ):
        return mode, {"message": payload[0], "metadata": payload[1]}
    return None


def message_text(message: object) -> str:
    """The generated text in one streamed message chunk. Content is a plain
    string for most chat models, or a list of content blocks (e.g.
    Anthropic) — only text blocks are kept."""
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in cast(list[object], content):
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = cast(dict[str, object], block).get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


async def pipeline_events(
    request: Request, run: PreparedRun
) -> AsyncIterator[tuple[str, BaseModel]]:
    """Streams a run via LangGraph's own astream(), in three stream modes:

    - "custom": a `node_start` event the moment a node begins calling its
      model (emitted by the node itself — see node_types.NODE_START_EVENT),
      and again with a higher `attempt` before each retry;
    - "messages": `node_token` events carrying the text each node's model
      is generating, as it generates it. LangChain chat models switch to
      streaming on their own when LangGraph's message handler is
      listening, so no provider adapter needs streaming code of its own;
    - "updates": one `node_complete` event per graph node as it finishes
      (a single chunk can hold several nodes when parallel siblings finish
      in the same superstep) and one `loop_iteration` event per loop
      increment.

    Ends with a `done` event carrying the complete result.

    CRITICAL DIFFERENCE FROM AN ANSWERED RUN'S ERROR HANDLING: by the time this
    generator starts running, StreamingResponse has already sent a 200
    status and started the response body — there is no way to change the
    HTTP status code partway through a response. So failures here can't
    `raise HTTPException` the way an answered run does; they're instead sent
    as an `error` SSE event carrying the same ErrorResponse shape it would
    have returned as an HTTP error, and the generator then simply stops (ending
    the stream) rather than propagating the exception further.
    """
    definition = run.definition
    node_outputs: dict[str, NodeResult] = {}
    completed: dict[str, NodeOutput] = {}  # what node_complete sent, reused by `done`
    loop_counts: dict[str, int] = {}
    # Only pipeline-defined nodes stream tokens to clients; internal graph
    # nodes (fan-out root, loop bookkeeping) never call a model anyway.
    pipeline_node_ids = {n.id for n in definition.nodes}

    try:
        # aclosing: a run that stops early (the client went away) closes
        # LangGraph's stream at once — cancelling its running nodes — rather
        # than whenever the abandoned generator gets garbage-collected.
        steps = cast(
            AsyncGenerator[object, None],
            run.graph.astream(
                run.initial_state,
                config=_run_config(definition),
                stream_mode=["updates", "custom", "messages"],
            ),
        )
        async with aclosing(steps):
            async for step in steps:
                part = extract_stream_part(step)
                if part is None:
                    logger.warning(
                        f"[stream:{definition.name}] unrecognized astream() chunk shape: "
                        f"{type(step).__name__} = {step!r}"
                    )
                    continue

                mode, chunk = part
                if mode == "messages":
                    metadata = chunk.get("metadata")
                    node_id = (
                        cast(dict[str, object], metadata).get("langgraph_node")
                        if isinstance(metadata, dict)
                        else None
                    )
                    text = message_text(chunk.get("message"))
                    if isinstance(node_id, str) and node_id in pipeline_node_ids and text:
                        yield "node_token", NodeTokenEvent(node_id=node_id, text=text)
                    continue
                if mode == "custom":
                    if chunk.get("event") == NODE_START_EVENT:
                        attempt = chunk.get("attempt", 1)
                        prompt = chunk.get("prompt")
                        system = chunk.get("system")
                        replayed = chunk.get("replayed")
                        yield (
                            "node_start",
                            NodeStartEvent(
                                node_id=str(chunk["node_id"]),
                                model_name=str(chunk["model_name"]),
                                attempt=attempt if isinstance(attempt, int) else 1,
                                prompt=prompt if isinstance(prompt, str) else None,
                                system=system if isinstance(system, str) else None,
                                replayed=replayed is True,
                            ),
                        )
                    continue
                if mode != "updates":
                    continue

                for _node_name, update in chunk.items():
                    if not isinstance(update, dict):
                        continue
                    node_update = update.get("node_outputs")
                    if isinstance(node_update, dict):
                        for node_id, result in node_update.items():
                            node_outputs[node_id] = result
                            completed[node_id] = NodeOutput.model_validate(result)
                            yield "node_complete", NodeCompleteEvent(node=completed[node_id])
                        continue
                    loop_update = update.get("loop_counts")
                    if isinstance(loop_update, dict):
                        for loop_id, count in loop_update.items():
                            loop_counts[loop_id] = count
                            yield (
                                "loop_iteration",
                                LoopIterationEvent(loop_id=loop_id, iteration=count),
                            )
                    # Anything else (e.g. the multi-root fan-out node's empty
                    # `{}` update) carries no client-visible information — skip.
    except PipelineExecutionError as e:
        logger.exception(f"Pipeline '{definition.name}' stream failed")
        yield (
            "error",
            build_error_response(
                request, ErrorCode.PIPELINE_RUN_FAILED, str(e), details=_failure_details(e)
            ),
        )
        return
    except Exception:
        logger.exception(f"Pipeline '{definition.name}' stream failed unexpectedly")
        yield (
            "error",
            build_error_response(request, ErrorCode.INTERNAL_ERROR, UNEXPECTED_RUN_FAILURE),
        )
        return

    resolved_output_node = _resolve_output_node(definition, node_outputs)
    if resolved_output_node is None:
        yield (
            "error",
            build_error_response(
                request,
                ErrorCode.PIPELINE_RUN_FAILED,
                f"Pipeline completed but none of its output_nodes "
                f"({', '.join(definition.output_nodes)}) produced a result",
            ),
        )
        return

    yield (
        "done",
        StreamDoneEvent(
            pipeline_name=definition.name,
            output_node=resolved_output_node,
            final_answer=node_outputs[resolved_output_node]["output"],
            node_outputs=completed,
            loop_iterations=loop_counts,
            remembered=_remembered(definition, node_outputs),
        ),
    )


async def _stream_pipeline_run(request: Request, run: PreparedRun) -> AsyncGenerator[str, None]:
    """pipeline_events as Server-Sent Events."""
    async for event_type, data in pipeline_events(request, run):
        yield sse_event(event_type, data)


def _quality(accept: str, *media_types: str) -> float:
    """The highest q-value the Accept header gives any of `media_types`
    (0 when it names none of them)."""
    best = 0.0
    for part in accept.split(","):
        media_type, *params = (piece.strip() for piece in part.split(";"))
        if media_type.lower() not in media_types:
            continue
        quality = 1.0
        for param in params:
            key, _, value = param.partition("=")
            if key.strip().lower() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        best = max(best, quality)
    return best


def wants_event_stream(request: Request) -> bool:
    """Whether the client prefers the run streamed as Server-Sent Events:
    it accepts `text/event-stream` more than JSON. JSON wins a tie, and
    `*/*` alone is no request for a stream."""
    accept = request.headers.get("accept", "")
    return _quality(accept, "text/event-stream") > _quality(
        accept, "application/json", "application/*", "*/*"
    )


@router.post(
    "/pipelines/{name}/runs",
    response_model=RunResponse,
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    # A streamed run's status is decided before streaming starts: only these
    # pre-stream errors (and 200) apply to it. Execution failures then
    # arrive as an `error` event within the 200 — see pipeline_events.
    responses={
        **{k: ERROR_RESPONSES[k] for k in (400, 401, 404, 422, 429, 500, 502)},
        200: {
            "content": {"text/event-stream": {}},
            "description": (
                "The finished run — or, with `Accept: text/event-stream`, the run as "
                "it happens: node_start / node_token / node_complete / loop_iteration "
                "events, then a done event (success) or an error event (failure)"
            ),
        },
    },
)
async def create_run(
    name: str,
    body: RunRequest,
    request: Request,
    cache: PipelineCache = Depends(get_pipeline_cache),
) -> RunResponse | StreamingResponse:
    """Runs pipeline `name` on `prompt` — answered when it finishes, or
    streamed as it runs when the client prefers `text/event-stream`."""
    if not wants_event_stream(request):
        return await run_pipeline(name, body, cache, request)
    run = await prepare_run(name, body, cache)
    return StreamingResponse(
        until_disconnected(request, _stream_pipeline_run(request, run)),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Disables response buffering on nginx specifically — without
            # this, a reverse proxy can buffer the whole stream and deliver
            # it all at once, silently defeating the point of streaming.
            "X-Accel-Buffering": "no",
        },
    )
