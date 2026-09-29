"""
Metrics to alert on, served at GET /metrics (routers/metrics.py) in
Prometheus' text format.

Logs say what went wrong after the fact; these say it while it's
happening — runs failing per minute, a model's circuit opening, a model
answering in 90 s instead of 5 — which is what someone can be paged on.
Every metric is defined here, and only recorded through the functions
below, so names, labels and label values stay consistent across the
modules that record them.

Every label value comes from a bounded set: pipeline names are files on
disk, model identities are what pipelines and the editor allowlist name.
Nothing client-supplied becomes a label (a client id, say), since every
distinct value is a new series kept for the life of the process.

With `uvicorn --workers N`, set PROMETHEUS_MULTIPROC_DIR to an empty
directory before the server starts, so a scrape — which reaches one
worker — reports every worker's counts. Without it, each worker reports
only its own.
"""

import os
import time
from typing import Literal

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
    multiprocess,
)

RunOutcome = Literal["completed", "failed", "timed_out", "cancelled"]
ModelCallOutcome = Literal["ok", "failed", "timeout", "circuit_open"]

# Model calls and runs take from well under a second to many minutes (a
# local model loading, a loop of revisions) — Prometheus' default buckets
# stop at 10 s, where every slow call would look the same.
_DURATION_BUCKETS = (0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0, 120.0, 300.0, 600.0)

_RUNS = Counter(
    "llm_pipeline_runs",
    "Pipeline runs that started, by how they ended. A request refused before "
    "its run starts (bad input, unknown pipeline) is no run.",
    ["pipeline", "outcome"],
)
_RUN_DURATION = Histogram(
    "llm_pipeline_run_duration_seconds",
    "How long pipeline runs took, start to end, by how they ended.",
    ["pipeline", "outcome"],
    buckets=_DURATION_BUCKETS,
)
_MODEL_CALLS = Counter(
    "llm_pipeline_model_calls",
    "Model call attempts — each retry counts — by result; circuit_open is a "
    "call the circuit breaker refused without calling the model.",
    ["model", "outcome"],
)
_MODEL_CALL_DURATION = Histogram(
    "llm_pipeline_model_call_duration_seconds",
    "How long each model call attempt took, by result. A call the circuit "
    "breaker refused never reached the model, so it isn't timed.",
    ["model", "outcome"],
    buckets=_DURATION_BUCKETS,
)
_TOKENS = Counter(
    "llm_pipeline_tokens",
    "Tokens used by successful model calls, as their backend reported them; "
    "kind is prompt or completion. A backend that reports none adds none.",
    ["model", "kind"],
)
_CIRCUIT_OPENED = Counter(
    "llm_pipeline_circuit_opened",
    "Times a model's circuit breaker opened: after too many consecutive "
    "failures, or when its trial call after a cooldown failed too.",
    ["model"],
)
_RATE_LIMITED = Counter(
    "llm_pipeline_rate_limited",
    "Requests refused with 429 by the per-client rate limit.",
)

CONTENT_TYPE = CONTENT_TYPE_LATEST


def record_run(pipeline: str, outcome: RunOutcome, started_at: float) -> None:
    """Counts a run that ended and times it — `started_at` is the
    time.monotonic() it started at."""
    _RUNS.labels(pipeline=pipeline, outcome=outcome).inc()
    _RUN_DURATION.labels(pipeline=pipeline, outcome=outcome).observe(time.monotonic() - started_at)


def record_model_call(
    model: str, outcome: ModelCallOutcome, started_at: float | None = None
) -> None:
    """Counts one model call attempt and times it from `started_at` (its
    time.monotonic() start) — None for a call the breaker refused, which
    never started."""
    _MODEL_CALLS.labels(model=model, outcome=outcome).inc()
    if started_at is not None:
        _MODEL_CALL_DURATION.labels(model=model, outcome=outcome).observe(
            time.monotonic() - started_at
        )


def count_tokens(model: str, prompt: int | None, completion: int | None) -> None:
    """The tokens one call used — either may be None: not every backend
    reports both."""
    if prompt:
        _TOKENS.labels(model=model, kind="prompt").inc(prompt)
    if completion:
        _TOKENS.labels(model=model, kind="completion").inc(completion)


def count_circuit_opened(model: str) -> None:
    _CIRCUIT_OPENED.labels(model=model).inc()


def count_rate_limited() -> None:
    _RATE_LIMITED.inc()


def exposition() -> bytes:
    """Every metric in Prometheus' text format — summed across worker
    processes when PROMETHEUS_MULTIPROC_DIR is set (see module docstring)."""
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(registry)  # type: ignore[no-untyped-call]
        return generate_latest(registry)
    return generate_latest(REGISTRY)
