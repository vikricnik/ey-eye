"""
A run's overall time limit: its pipeline's `execution.run_timeout_seconds`.

model_timeout_seconds bounds each model call, but a run is many calls —
retried, some in loops — so nothing else bounds a run as a whole. Past the
limit the run is stopped, which cancels its model calls in flight
(LangGraph cancels the running nodes, and a dropped request makes Ollama
stop generating), and RunTimedOut is raised. None means no limit.
"""

import asyncio
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable
from typing import TypeVar

from llm_pipeline.errors import RunTimedOut

T = TypeVar("T")


async def within_run_timeout(limit: float | None, work: Awaitable[T]) -> T:
    """`work`'s result — or, once `limit` seconds have passed, `work` is
    cancelled and RunTimedOut raised."""
    if limit is None:
        return await work
    scope = asyncio.timeout(limit)
    try:
        async with scope:
            return await work
    except TimeoutError as e:
        if scope.expired():
            raise RunTimedOut(limit) from e
        raise  # a timeout inside the run, not its limit


async def steps_within_run_timeout(
    limit: float | None, steps: AsyncIterator[T]
) -> AsyncGenerator[T, None]:
    """`steps` as they come, until `limit` seconds after the first was asked
    for — then the step being waited for is cancelled and RunTimedOut raised.

    Each wait gets what is left of the limit, rather than one timeout around
    the whole iteration: a streamed run is resumed from a new task for every
    event (see disconnects.until_disconnected), and an asyncio.timeout
    belongs to the task that entered it."""
    if limit is None:
        async for step in steps:
            yield step
        return
    deadline = asyncio.get_running_loop().time() + limit
    while True:
        scope = asyncio.timeout_at(deadline)
        try:
            async with scope:
                step = await anext(steps)
        except StopAsyncIteration:
            return
        except TimeoutError as e:
            if scope.expired():
                raise RunTimedOut(limit) from e
            raise
        yield step
