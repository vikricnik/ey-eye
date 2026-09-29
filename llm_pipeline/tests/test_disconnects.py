"""A client that goes away stops its run — down to the model call."""

import asyncio
import gc
from collections.abc import AsyncGenerator
from typing import cast

import pytest
from fastapi import HTTPException, Request

import llm_pipeline.dag_builder.node_types as node_types_module
import llm_pipeline.disconnects as disconnects_module
from llm_pipeline.dag_builder import build_graph
from llm_pipeline.disconnects import cancel_on_disconnect, until_disconnected
from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.providers import Generation
from llm_pipeline.routers.runs import PreparedRun, pipeline_events
from llm_pipeline.state import PipelineState


class _Client:
    """Stands in for a Request: only is_disconnected() is used (and, for
    error events, method/url)."""

    method = "POST"

    class url:
        path = "/v1/workflows/slow/runs"

    def __init__(self) -> None:
        self.gone = False

    async def is_disconnected(self) -> bool:
        return self.gone


@pytest.fixture(autouse=True)
def _poll_fast(monkeypatch: pytest.MonkeyPatch) -> None:  # pyright: ignore[reportUnusedFunction]
    monkeypatch.setattr(disconnects_module, "POLL_SECONDS", 0.01)


class _Hanging:
    """Work that never finishes on its own; records being cancelled."""

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.cancelled = False

    async def run(self) -> str:
        self.started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return "never"


@pytest.mark.asyncio
async def test_plain_work_finishes_or_is_cancelled_when_the_client_leaves() -> None:
    client = _Client()

    async def quick() -> str:
        return "done"

    assert await cancel_on_disconnect(cast(Request, client), quick()) == "done"

    hanging = _Hanging()
    task = asyncio.ensure_future(cancel_on_disconnect(cast(Request, client), hanging.run()))
    await hanging.started.wait()
    client.gone = True
    with pytest.raises(HTTPException) as raised:
        await asyncio.wait_for(task, timeout=2)
    assert raised.value.status_code == 499
    assert hanging.cancelled


@pytest.mark.asyncio
async def test_a_stream_stops_when_the_client_leaves() -> None:
    client = _Client()
    hanging = _Hanging()

    async def events() -> AsyncGenerator[str, None]:
        yield "first"
        yield await hanging.run()

    stream = until_disconnected(cast(Request, client), events())
    assert await anext(stream) == "first"
    await_next = asyncio.ensure_future(anext(stream))
    await hanging.started.wait()
    client.gone = True
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(await_next, timeout=2)
    assert hanging.cancelled


@pytest.mark.asyncio
async def test_leaving_mid_run_cancels_the_model_call(monkeypatch: pytest.MonkeyPatch) -> None:
    """Through LangGraph: the node's provider call itself is cancelled — for
    Ollama, dropping that request is what stops generation."""
    hanging = _Hanging()

    class _Provider:
        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            return Generation(await hanging.run())

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _Provider())
    definition = PipelineDefinition.model_validate(
        {
            "name": "slow",
            "nodes": [
                {
                    "id": "answer",
                    "model": {"provider": "ollama", "name": "m"},
                    "prompt_template": "{{ input }}",
                }
            ],
            "output_nodes": ["answer"],
        }
    )
    state: PipelineState = {
        "input": "q",
        "contextual_input": "q",
        "history": "",
        "node_outputs": {},
        "loop_counts": {},
    }
    client = _Client()
    request = cast(Request, client)

    async def sse() -> AsyncGenerator[str, None]:
        run = PreparedRun(definition, build_graph(definition), state)
        async for kind, _data in pipeline_events(request, run):
            yield kind

    stream = until_disconnected(request, sse())
    assert await anext(stream) == "node_start"
    await hanging.started.wait()
    client.gone = True
    with pytest.raises(StopAsyncIteration):
        await asyncio.wait_for(anext(stream), timeout=2)
    assert hanging.cancelled
    # LangGraph leaves a cancelled internal coroutine to the garbage
    # collector; finalize it while this test's event loop still runs.
    await asyncio.sleep(0.05)
    gc.collect()
