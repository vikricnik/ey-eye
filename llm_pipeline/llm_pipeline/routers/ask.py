import logging
from collections.abc import AsyncIterator
from typing import cast

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from langgraph.graph.state import CompiledStateGraph
from pydantic import BaseModel

from llm_pipeline.api_schemas import (
    AskRequest,
    AskResponse,
    ConversationTurn,
    LoopIterationEvent,
    NodeCompleteEvent,
    NodeOutputDTO,
    StreamDoneEvent,
)
from llm_pipeline.state import PipelineState, NodeResult
from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.history import build_contextual_input
from llm_pipeline.errors import PipelineExecutionError, PipelineNotFoundError
from llm_pipeline.settings import settings
from llm_pipeline.auth import require_api_key
from llm_pipeline.rate_limit import enforce_rate_limit
from llm_pipeline.error_handling import ERROR_RESPONSES, build_error_response
from llm_pipeline.pipeline_loader import PipelineCache, get_pipeline_cache

logger: logging.Logger = logging.getLogger("llm_pipeline")

router = APIRouter()


def _validate_prompt_and_history(req: AskRequest) -> None:
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt cannot be empty")

    if len(req.prompt) > settings.max_prompt_length:
        raise HTTPException(
            status_code=400,
            detail=(
                f"prompt exceeds max_prompt_length ({len(req.prompt)} > "
                f"{settings.max_prompt_length} characters)"
            ),
        )

    for i, turn in enumerate(req.history):
        if len(turn.prompt) > settings.max_history_turn_length:
            raise HTTPException(
                status_code=400,
                detail=f"history[{i}].prompt exceeds max_history_turn_length",
            )
        if len(turn.final_answer) > settings.max_history_turn_length:
            raise HTTPException(
                status_code=400,
                detail=f"history[{i}].final_answer exceeds max_history_turn_length",
            )


def _prepare_ask(
    req: AskRequest, cache: PipelineCache
) -> tuple[PipelineDefinition, CompiledStateGraph, PipelineState]:
    """Shared setup for both /ask and /ask/stream: validates the request,
    resolves the pipeline, and builds the initial LangGraph state. Every
    error raised here is a normal HTTPException with the correct status
    code — this always runs BEFORE either endpoint has sent any response
    (streaming or not), so raising here is always safe. Once /ask/stream
    starts actually streaming, that safety no longer holds — see
    _stream_pipeline_run's docstring."""
    _validate_prompt_and_history(req)

    try:
        definition, graph = cache.get(req.pipeline_name)
    except PipelineNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))

    trimmed_history: list[ConversationTurn] = (
        req.history[-definition.execution.max_history_turns :]
        if definition.execution.max_history_turns > 0
        else []
    )
    contextual_input = build_contextual_input(req.prompt, trimmed_history)

    initial_state: PipelineState = {
        "input": req.prompt,
        "contextual_input": contextual_input,
        "node_outputs": {},
        "loop_counts": {},
    }
    return definition, graph, initial_state


def _resolve_output_node(
    definition: PipelineDefinition, node_outputs: dict[str, NodeResult]
) -> str | None:
    """output_node is one or more CANDIDATES, not a single fixed id — once a
    branch means only one of several possible "final" nodes actually runs
    per request, whichever candidate is actually present wins."""
    for candidate in definition.output_node_candidates:
        if candidate in node_outputs:
            return candidate
    return None


@router.post(
    "/ask",
    response_model=AskResponse,
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    responses={k: ERROR_RESPONSES[k] for k in (400, 401, 404, 422, 429, 502, 503)},
)
async def ask(
    req: AskRequest, cache: PipelineCache = Depends(get_pipeline_cache)
) -> AskResponse:
    definition, graph, initial_state = _prepare_ask(req, cache)

    try:
        # graph.ainvoke's declared return type is generic (LangGraph doesn't
        # know about our specific PipelineState TypedDict) — cast makes
        # explicit what we already know: our own node functions and state
        # reducers guarantee this exact shape at runtime.
        final_state: PipelineState = cast(PipelineState, await graph.ainvoke(initial_state))
    except PipelineExecutionError as e:
        logger.exception(f"Pipeline '{req.pipeline_name}' run failed")
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.exception(f"Pipeline '{req.pipeline_name}' run failed unexpectedly")
        raise HTTPException(status_code=502, detail=f"Pipeline error: {e}")

    node_outputs = final_state["node_outputs"]
    resolved_output_node = _resolve_output_node(definition, node_outputs)

    if resolved_output_node is None:
        raise HTTPException(
            status_code=502,
            detail=(
                f"Pipeline completed but none of its output_node candidates "
                f"({', '.join(definition.output_node_candidates)}) produced a result"
            ),
        )

    return AskResponse(
        pipeline_name=definition.name,
        output_node=resolved_output_node,
        final_answer=node_outputs[resolved_output_node]["output"],
        node_outputs={
            node_id: NodeOutputDTO(**result) for node_id, result in node_outputs.items()
        },
        loop_iterations=final_state.get("loop_counts", {}),
    )


def _sse(event_type: str, data: BaseModel) -> str:
    """Formats one Server-Sent Event. The blank line at the end is
    required by the SSE spec to terminate the event."""
    return f"event: {event_type}\ndata: {data.model_dump_json()}\n\n"


def _extract_chunk(step: object) -> dict[str, object] | None:
    """Normalizes one value yielded by graph.astream(..., stream_mode="updates")
    into a plain {node_name: update} dict, or None if the shape isn't
    recognized. Pulled out as a standalone function specifically so this can
    be unit-tested against both known shapes directly — see
    tests/test_streaming.py — without needing to mock LangGraph's astream()
    itself or depend on which shape the installed LangGraph version
    actually produces."""
    if isinstance(step, dict):
        return step
    if isinstance(step, tuple) and len(step) == 2 and isinstance(step[1], dict):
        return step[1]
    return None


async def _stream_pipeline_run(
    request: Request,
    req: AskRequest,
    definition: PipelineDefinition,
    graph: CompiledStateGraph,
    initial_state: PipelineState,
) -> AsyncIterator[str]:
    """Node-level streaming via LangGraph's own astream(), NOT token-level
    streaming from each LLM call — this fires one `node_complete` event per
    graph node as it finishes (which includes parallel branches: a single
    astream "chunk" can contain more than one node if several completed in
    the same superstep), one `loop_iteration` event per loop increment, and
    a final `done` event with the complete result. Works identically across
    every provider without any of them needing to implement token
    streaming individually.

    CRITICAL DIFFERENCE FROM /ask'S ERROR HANDLING: by the time this
    generator starts running, StreamingResponse has already sent a 200
    status and started the response body — there is no way to change the
    HTTP status code partway through a response. So failures here can't
    `raise HTTPException` the way /ask does; they're instead sent as an
    `error` SSE event carrying the same ErrorResponse shape /ask would have
    returned as an HTTP error, and the generator then simply stops (ending
    the stream) rather than propagating the exception further.
    """
    node_outputs: dict[str, NodeResult] = {}
    loop_counts: dict[str, int] = {}

    try:
        async for step in graph.astream(initial_state, stream_mode="updates"):
            # LangGraph's astream() shape for a single string stream_mode is
            # documented as yielding the chunk dict directly, but this has
            # been observed to vary — some versions/configurations instead
            # yield a (mode_name, chunk) tuple even for one mode. See
            # _extract_chunk's docstring.
            chunk = _extract_chunk(step)
            if chunk is None:
                logger.warning(
                    f"[stream:{req.pipeline_name}] unrecognized astream() chunk shape: "
                    f"{type(step).__name__} = {step!r}"
                )
                continue

            for _node_name, update in chunk.items():
                if not isinstance(update, dict):
                    continue
                node_update = update.get("node_outputs")
                if isinstance(node_update, dict):
                    for node_id, result in node_update.items():
                        node_outputs[node_id] = result
                        yield _sse("node_complete", NodeCompleteEvent(node=NodeOutputDTO(**result)))
                    continue
                loop_update = update.get("loop_counts")
                if isinstance(loop_update, dict):
                    for loop_id, count in loop_update.items():
                        loop_counts[loop_id] = count
                        yield _sse(
                            "loop_iteration", LoopIterationEvent(loop_id=loop_id, iteration=count)
                        )
                # Anything else (e.g. the multi-root fan-out node's empty
                # `{}` update) carries no client-visible information — skip.
    except PipelineExecutionError as e:
        logger.exception(f"Pipeline '{req.pipeline_name}' stream failed")
        yield _sse("error", build_error_response(request, 503, str(e)))
        return
    except Exception as e:
        logger.exception(f"Pipeline '{req.pipeline_name}' stream failed unexpectedly")
        yield _sse("error", build_error_response(request, 502, f"Pipeline error: {e}"))
        return

    resolved_output_node = _resolve_output_node(definition, node_outputs)
    if resolved_output_node is None:
        yield _sse(
            "error",
            build_error_response(
                request,
                502,
                f"Pipeline completed but none of its output_node candidates "
                f"({', '.join(definition.output_node_candidates)}) produced a result",
            ),
        )
        return

    yield _sse(
        "done",
        StreamDoneEvent(
            pipeline_name=definition.name,
            output_node=resolved_output_node,
            final_answer=node_outputs[resolved_output_node]["output"],
            node_outputs={
                node_id: NodeOutputDTO(**result) for node_id, result in node_outputs.items()
            },
            loop_iterations=loop_counts,
        ),
    )


@router.post(
    "/ask/stream",
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    # Only PRE-stream errors are documented here (400/401/404/422/429) —
    # once streaming actually starts the HTTP status is always 200
    # regardless of what happens next; execution-time failures surface as
    # an `error` SSE event within that 200 response instead, not as a
    # different HTTP status. See _stream_pipeline_run's docstring.
    responses={
        **{k: ERROR_RESPONSES[k] for k in (400, 401, 404, 422, 429)},
        200: {
            "content": {"text/event-stream": {}},
            "description": (
                "SSE stream: node_complete / loop_iteration events as the pipeline runs, "
                "then either a done event (success) or an error event (failure)"
            ),
        },
    },
)
async def ask_stream(
    req: AskRequest, request: Request, cache: PipelineCache = Depends(get_pipeline_cache)
) -> StreamingResponse:
    definition, graph, initial_state = _prepare_ask(req, cache)
    return StreamingResponse(
        _stream_pipeline_run(request, req, definition, graph, initial_state),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Disables response buffering on nginx specifically — without
            # this, a reverse proxy can buffer the whole stream and deliver
            # it all at once, silently defeating the point of streaming.
            "X-Accel-Buffering": "no",
        },
    )
