"""
OpenAI-compatible chat endpoints: every pipeline is a "model", so tools that
speak the OpenAI API — Open WebUI, Continue, the openai SDKs — can chat with
pipelines without knowing this API. Clients use `http://<server>/openai/v1`
as their OpenAI base URL. Mounted there rather than at /v1, which is kept
for this API's own versioning (spec 003's /v1/workflows).

- GET  /openai/v1/models lists the pipelines.
- POST /openai/v1/chat/completions runs the pipeline named by `model`. The last
  message must be the user's (consecutive trailing user messages are joined);
  earlier user/assistant pairs become the conversation history, subject to
  the pipeline's history settings. System messages and generation
  parameters (temperature, max_tokens, …) are ignored: a pipeline's nodes
  carry their own system prompts and settings.

Streaming sends chat.completion.chunk events. The output node's text streams
live when there is exactly one output node, no loops (a loop would stream
every draft) and no reasoning stripping on it (the <think> block would
stream too); otherwise the answer arrives in one piece at the end. `usage`
sums every model call in the run.

Auth and rate limits are the same as /ask — OpenAI clients send the API key
as `Authorization: Bearer`, which require_api_key accepts. Errors use
OpenAI's error shape (see openai_error and OpenAIErrorRoute).
"""

import json
import time
import uuid
from collections.abc import AsyncGenerator, Callable, Coroutine, Iterable
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from llm_pipeline.api_error import ApiError
from llm_pipeline.api_schemas import (
    AskRequest,
    ConversationTurn,
    ErrorCode,
    ErrorResponse,
    NodeOutputDTO,
    NodeStartEvent,
    NodeTokenEvent,
    StreamDoneEvent,
)
from llm_pipeline.auth import require_api_key
from llm_pipeline.disconnects import until_disconnected
from llm_pipeline.error_handling import (
    error_response_from_http_exception,
    error_response_from_validation_error,
)
from llm_pipeline.pipeline_config import PipelineDefinition, list_available_pipelines
from llm_pipeline.pipeline_config.effective import effective_node
from llm_pipeline.pipeline_loader import PipelineCache, get_pipeline_cache
from llm_pipeline.rate_limit import enforce_rate_limit
from llm_pipeline.routers.ask import pipeline_events, prepare_ask, run_ask
from llm_pipeline.settings import settings

# Shown between the output node's failed attempt and its retry: text that
# was already streamed can't be taken back.
RETRY_NOTICE = "\n\n[retrying after an error]\n\n"


# -- errors --------------------------------------------------------------------

_OPENAI_ERROR_TYPES = {
    401: "authentication_error",
    403: "permission_error",
    429: "rate_limit_error",
}


def openai_error(body: ErrorResponse) -> dict[str, object]:
    """The error shape OpenAI clients understand, carrying the same message
    and reference id as the ErrorResponse the rest of this API returns."""
    error_type = _OPENAI_ERROR_TYPES.get(
        body.status, "server_error" if body.status >= 500 else "invalid_request_error"
    )
    return {
        "error": {
            "message": body.message,
            "type": error_type,
            "param": None,
            "code": body.code.lower(),  # e.g. "pipeline_not_found"
            "exceptionUID": body.exceptionUID,
        }
    }


class OpenAIErrorRoute(APIRoute):
    """A route that answers its errors in OpenAI's shape. Auth, rate-limit
    and request-validation errors are raised while FastAPI resolves the
    route's dependencies and body — inside the handler wrapped here — so
    they are converted before the app-wide handlers in error_handling.py,
    which keep ErrorResponse for every other route."""

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handle = super().get_route_handler()

        async def handle_with_openai_errors(request: Request) -> Response:
            try:
                return await handle(request)
            except HTTPException as exc:
                body = error_response_from_http_exception(request, exc)
                return JSONResponse(
                    openai_error(body), status_code=body.status, headers=exc.headers
                )
            except RequestValidationError as exc:
                body = error_response_from_validation_error(request, exc)
                return JSONResponse(openai_error(body), status_code=body.status)

        return handle_with_openai_errors


router = APIRouter(
    prefix="/openai/v1",
    route_class=OpenAIErrorRoute,
    dependencies=[Depends(require_api_key)],
)


# -- request -------------------------------------------------------------------


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    role: str
    # A string, or content parts ({"type": "text", "text": …}); only text is used.
    content: str | list[dict[str, object]] | None = None

    @property
    def text(self) -> str:
        if isinstance(self.content, str):
            return self.content
        parts = self.content or []
        return "".join(
            str(part.get("text", "")) for part in parts if part.get("type") in (None, "text")
        )


class StreamOptions(BaseModel):
    model_config = ConfigDict(extra="ignore")

    include_usage: bool = False


class ChatCompletionRequest(BaseModel):
    # OpenAI clients send many more parameters; they don't apply here.
    model_config = ConfigDict(extra="ignore")

    model: str
    messages: list[ChatMessage] = Field(min_length=1)
    stream: bool = False
    stream_options: StreamOptions | None = None


# -- response ------------------------------------------------------------------


class ChatCompletionUsage(BaseModel):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class AssistantMessage(BaseModel):
    role: Literal["assistant"] = "assistant"
    content: str


class Choice(BaseModel):
    index: int = 0
    message: AssistantMessage
    finish_reason: Literal["stop"] = "stop"


class ChatCompletion(BaseModel):
    id: str
    object: Literal["chat.completion"] = "chat.completion"
    created: int
    model: str
    choices: list[Choice]
    usage: ChatCompletionUsage


class Delta(BaseModel):
    role: Literal["assistant"] | None = None
    content: str | None = None


class ChunkChoice(BaseModel):
    index: int = 0
    delta: Delta
    finish_reason: Literal["stop"] | None = None


class ChatCompletionChunk(BaseModel):
    id: str
    object: Literal["chat.completion.chunk"] = "chat.completion.chunk"
    created: int
    model: str
    choices: list[ChunkChoice]
    usage: ChatCompletionUsage | None = None


class ModelCard(BaseModel):
    id: str
    object: Literal["model"] = "model"
    created: int = 0
    owned_by: str = "llm-pipeline"


class ModelList(BaseModel):
    object: Literal["list"] = "list"
    data: list[ModelCard]


# -- mapping -------------------------------------------------------------------


def conversation(messages: list[ChatMessage]) -> tuple[str, list[ConversationTurn]]:
    """The new prompt and the history before it. Each assistant message
    answers the user message(s) before it; system messages are dropped."""
    exchange = [m for m in messages if m.role in ("user", "assistant")]
    if not exchange or exchange[-1].role != "user":
        raise ApiError(ErrorCode.INPUT_INVALID, "the last message must be the user's")

    history: list[ConversationTurn] = []
    asked: list[str] = []
    for message in exchange:
        if message.role == "user":
            asked.append(message.text)
        elif asked:
            history.append(ConversationTurn(prompt="\n\n".join(asked), final_answer=message.text))
            asked = []
    return "\n\n".join(asked), history


def total_usage(nodes: Iterable[NodeOutputDTO]) -> ChatCompletionUsage:
    reported = [n.usage for n in nodes if n.usage is not None]
    prompt = sum(u.prompt_tokens or 0 for u in reported)
    completion = sum(u.completion_tokens or 0 for u in reported)
    return ChatCompletionUsage(
        prompt_tokens=prompt, completion_tokens=completion, total_tokens=prompt + completion
    )


def live_output_node(definition: PipelineDefinition) -> str | None:
    """The node whose tokens can be streamed as the answer, if any — see the
    module docstring for why the others arrive in one piece."""
    candidates = definition.output_node_candidates
    if len(candidates) != 1 or definition.loops:
        return None
    node = next(n for n in definition.nodes if n.id == candidates[0])
    return None if effective_node(definition, node).strip_reasoning else node.id


# -- endpoints -----------------------------------------------------------------


@router.get("/models", response_model=ModelList, dependencies=[Depends(enforce_rate_limit)])
async def list_models() -> ModelList:
    return ModelList(
        data=[ModelCard(id=p.name) for p in list_available_pipelines(settings.pipelines_path)]
    )


@router.post(
    "/chat/completions",
    response_model=ChatCompletion,
    dependencies=[Depends(enforce_rate_limit)],
    responses={
        200: {
            "content": {"text/event-stream": {}},
            "description": "a chat.completion, or chat.completion.chunk events when streaming",
        }
    },
)
async def chat_completions(
    body: ChatCompletionRequest,
    request: Request,
    cache: PipelineCache = Depends(get_pipeline_cache),
) -> ChatCompletion | StreamingResponse:
    prompt, history = conversation(body.messages)
    req = AskRequest(prompt=prompt, pipeline_name=body.model, history=history)
    completion_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())

    if not body.stream:
        answer = await run_ask(req, cache, request)
        return ChatCompletion(
            id=completion_id,
            created=created,
            model=body.model,
            choices=[Choice(message=AssistantMessage(content=answer.final_answer))],
            usage=total_usage(answer.node_outputs.values()),
        )

    definition, graph, initial_state = await prepare_ask(req, cache)
    include_usage = body.stream_options is not None and body.stream_options.include_usage

    def chunk(delta: Delta, finish: bool = False) -> str:
        data = ChatCompletionChunk(
            id=completion_id,
            created=created,
            model=body.model,
            choices=[ChunkChoice(delta=delta, finish_reason="stop" if finish else None)],
        )
        return f"data: {data.model_dump_json(exclude_none=True)}\n\n"

    async def stream() -> AsyncGenerator[str, None]:
        live = live_output_node(definition)
        streamed = False
        yield chunk(Delta(role="assistant", content=""))
        async for _kind, data in pipeline_events(request, req, definition, graph, initial_state):
            if isinstance(data, NodeTokenEvent) and data.node_id == live:
                streamed = True
                yield chunk(Delta(content=data.text))
            elif isinstance(data, NodeStartEvent) and data.node_id == live and data.attempt > 1:
                if streamed:
                    yield chunk(Delta(content=RETRY_NOTICE))
            elif isinstance(data, ErrorResponse):
                # openai-python raises on a streamed event carrying `error`.
                yield f"data: {json.dumps(openai_error(data))}\n\n"
                break
            elif isinstance(data, StreamDoneEvent):
                if not streamed:
                    yield chunk(Delta(content=data.final_answer))
                yield chunk(Delta(), finish=True)
                if include_usage:
                    usage_chunk = ChatCompletionChunk(
                        id=completion_id,
                        created=created,
                        model=body.model,
                        choices=[],
                        usage=total_usage(data.node_outputs.values()),
                    )
                    yield f"data: {usage_chunk.model_dump_json(exclude_none=True)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        until_disconnected(request, stream()),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
