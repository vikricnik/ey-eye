import logging
from typing import cast

from fastapi import APIRouter, Depends, HTTPException

from llm_pipeline.api_schemas import (
    AskRequest,
    AskResponse,
    ConversationTurn,
    NodeOutputDTO,
)
from llm_pipeline.auth import require_api_key
from llm_pipeline.error_handling import ERROR_RESPONSES
from llm_pipeline.errors import PipelineExecutionError, PipelineNotFoundError
from llm_pipeline.history import build_contextual_input
from llm_pipeline.pipeline_loader import PipelineCache, get_pipeline_cache
from llm_pipeline.rate_limit import enforce_rate_limit
from llm_pipeline.settings import settings
from llm_pipeline.state import PipelineState

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


@router.post(
    "/ask",
    response_model=AskResponse,
    dependencies=[Depends(require_api_key), Depends(enforce_rate_limit)],
    responses={k: ERROR_RESPONSES[k] for k in (400, 401, 404, 422, 429, 502, 503)},
)
async def ask(
    req: AskRequest, cache: PipelineCache = Depends(get_pipeline_cache)
) -> AskResponse:
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

    # output_node is one or more CANDIDATES, not a single fixed id — once a
    # branch means only one of several possible "final" nodes actually runs
    # per request, the server picks whichever candidate is actually present.
    resolved_output_node: str | None = None
    for candidate in definition.output_node_candidates:
        if candidate in node_outputs:
            resolved_output_node = candidate
            break

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
