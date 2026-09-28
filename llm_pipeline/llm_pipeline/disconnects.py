"""
Stopping a run when its client goes away — a Stop button, Ctrl+C in the CLI
or a closed tab shouldn't leave a local model generating for minutes.

Starlette alone doesn't cover it. Under ASGI 2.4 (what uvicorn speaks) a
streaming response only notices a disconnect when it next writes, and a model
loading or thinking can be silent for a long time; a plain response never
notices. Both helpers here poll Request.is_disconnected() and cancel the run,
which cancels its model calls: LangGraph cancels the running nodes, and the
provider's dropped HTTP request makes Ollama stop generating.
"""

import asyncio
from collections.abc import AsyncGenerator, Awaitable
from contextlib import suppress
from typing import TypeVar

from fastapi import Request

from llm_pipeline.api_error import ApiError
from llm_pipeline.api_schemas import ErrorCode

POLL_SECONDS = 0.5

T = TypeVar("T")


async def cancel_on_disconnect(request: Request, work: Awaitable[T]) -> T:
    """`work`'s result — or, if the client disconnects first, `work` is
    cancelled and a 499 raised (for the logs: nobody is listening)."""
    task = asyncio.ensure_future(work)
    try:
        while not task.done():
            await asyncio.wait({task}, timeout=POLL_SECONDS)
            if not task.done() and await request.is_disconnected():
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task
                raise ApiError(ErrorCode.REQUEST_CANCELLED, "the client closed the request")
        return task.result()
    finally:
        task.cancel()  # a no-op once done; stops the work if this handler was cancelled


async def until_disconnected(
    request: Request, events: AsyncGenerator[str, None]
) -> AsyncGenerator[str, None]:
    """Passes `events` through until the client disconnects, then stops them
    — cancelling whatever they were waiting on."""
    pending = asyncio.ensure_future(anext(events))
    try:
        while True:
            done, _ = await asyncio.wait({pending}, timeout=POLL_SECONDS)
            if not done:
                if await request.is_disconnected():
                    return
                continue
            try:
                event = pending.result()
            except StopAsyncIteration:
                return
            yield event
            pending = asyncio.ensure_future(anext(events))
    finally:
        pending.cancel()
        with suppress(asyncio.CancelledError, StopAsyncIteration):
            await pending
        # RuntimeError: still running — only if this generator was itself
        # cancelled mid-await; the cancellation already reaches `events`.
        with suppress(RuntimeError):
            await events.aclose()
