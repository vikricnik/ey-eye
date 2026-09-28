"""
Internal pipeline execution state — LangGraph plumbing, not part of the
public HTTP API. See api_schemas.py for the request/response contract
clients actually depend on; this module is free to change shape without
that being a breaking API change, since nothing here crosses the wire
directly (routers/runs.py translates PipelineState into RunResponse
before it ever reaches a client).
"""

from typing import Annotated, NotRequired, TypedDict


class NodeUsage(TypedDict):
    """See api_schemas.NodeUsage."""

    prompt_tokens: int | None
    completion_tokens: int | None
    generation_ms: float | None
    context_window: int | None
    prompt_chars: int | None


class NodeResult(TypedDict):
    node_id: str
    model_name: str  # provider:model identity, e.g. "ollama:qwen3-coder:30b"
    output: str
    duration_ms: float
    # Absent when the model's backend reported nothing.
    usage: NotRequired[NodeUsage]
    # True when a re-run reused this output from the previous run instead
    # of calling the model (see rerun.py).
    replayed: NotRequired[bool]


def merge_node_outputs(a: dict[str, NodeResult], b: dict[str, NodeResult]) -> dict[str, NodeResult]:
    """Reducer for parallel nodes writing to the same state key: each node
    writes its own unique node_id key, so siblings completing in the same
    LangGraph superstep merge without colliding. Also correctly holds only
    the LATEST result for a node that runs multiple times in a loop, since
    a later write to the same key simply overwrites the earlier one."""
    merged = dict(a)
    merged.update(b)
    return merged


def merge_loop_counts(a: dict[str, int], b: dict[str, int]) -> dict[str, int]:
    """Reducer for loop iteration counters — same merge-by-key shape as
    merge_node_outputs, just for the small int-valued loop_counts map."""
    merged = dict(a)
    merged.update(b)
    return merged


class PipelineState(TypedDict):
    input: str  # the new message on its own (the {{ message }} variable)
    contextual_input: str  # input with conversation history folded in ({{ conversation }})
    history: str  # just the earlier turns ({{ history }}); "" when there are none
    node_outputs: Annotated[dict[str, NodeResult], merge_node_outputs]
    loop_counts: Annotated[dict[str, int], merge_loop_counts]
    # A re-run's reused outputs: node id -> the output it replays on its
    # first execution instead of calling its model. See rerun.py.
    replay: NotRequired[dict[str, str]]
