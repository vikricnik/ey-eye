"""
Counters to alert on, served at GET /metrics (routers/metrics.py) in
Prometheus' text format.

Logs say what went wrong after the fact; these say it while it's
happening — runs failing per minute, a model's circuit opening — which is
what someone can be paged on. Every counter is defined here, and only
counted through the functions below, so names, labels and label values
stay consistent across the modules that count them.

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
from typing import Literal

from prometheus_client import (
    CONTENT_TYPE_LATEST,
    REGISTRY,
    CollectorRegistry,
    Counter,
    generate_latest,
    multiprocess,
)

RunOutcome = Literal["completed", "failed", "cancelled"]
ModelCallOutcome = Literal["ok", "failed", "timeout", "circuit_open"]

_RUNS = Counter(
    "llm_pipeline_runs",
    "Pipeline runs that started, by how they ended. A request refused before "
    "its run starts (bad input, unknown pipeline) is no run.",
    ["pipeline", "outcome"],
)
_MODEL_CALLS = Counter(
    "llm_pipeline_model_calls",
    "Model call attempts — each retry counts — by result; circuit_open is a "
    "call the circuit breaker refused without calling the model.",
    ["model", "outcome"],
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


def count_run(pipeline: str, outcome: RunOutcome) -> None:
    _RUNS.labels(pipeline=pipeline, outcome=outcome).inc()


def count_model_call(model: str, outcome: ModelCallOutcome) -> None:
    _MODEL_CALLS.labels(model=model, outcome=outcome).inc()


def count_circuit_opened(model: str) -> None:
    _CIRCUIT_OPENED.labels(model=model).inc()


def count_rate_limited() -> None:
    _RATE_LIMITED.inc()


def exposition() -> bytes:
    """Every counter in Prometheus' text format — summed across worker
    processes when PROMETHEUS_MULTIPROC_DIR is set (see module docstring)."""
    if os.environ.get("PROMETHEUS_MULTIPROC_DIR"):
        registry = CollectorRegistry()
        multiprocess.MultiProcessCollector(registry)  # type: ignore[no-untyped-call]
        return generate_latest(registry)
    return generate_latest(REGISTRY)
