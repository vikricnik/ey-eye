"""
Request correlation IDs for structured logging.

Without this, concurrent requests' log lines interleave with no way to tell
which lines belong to which request. This gives every request a short id
(reused from the client's X-Request-ID header if provided, otherwise
generated), stashes it in a contextvar, and injects it into every log
record automatically via a logging.Filter — so existing `logger.info(...)`
calls throughout dag_builder.py etc. don't need to change at all to start
including it.

Lines are human-readable by default; LOG_FORMAT=json writes one JSON object
per line instead, for log search tools (see JsonLogFormatter).
"""

import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from datetime import UTC, datetime
from typing import Literal

from fastapi import Request, Response

LogFormat = Literal["text", "json"]

_request_id_var: ContextVar[str] = ContextVar("request_id", default="-")


def get_request_id() -> str:
    return _request_id_var.get()


class RequestIdLogFilter(logging.Filter):
    """Attach the current request's id to every LogRecord as %(request_id)s."""

    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = get_request_id()
        return True


async def request_id_middleware(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    incoming_id = request.headers.get("X-Request-ID")
    request_id = incoming_id if incoming_id else uuid.uuid4().hex[:12]

    token = _request_id_var.set(request_id)
    try:
        response = await call_next(request)
    finally:
        _request_id_var.reset(token)

    response.headers["X-Request-ID"] = request_id
    return response


class JsonLogFormatter(logging.Formatter):
    """One JSON object per line: time (UTC, ISO 8601), level, logger,
    request_id and message — plus the traceback, when there is one — so a
    log search tool can filter on each field rather than parse text."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "time": datetime.fromtimestamp(record.created, tz=UTC).isoformat(
                timespec="milliseconds"
            ),
            "level": record.levelname,
            "logger": record.name,
            "request_id": getattr(record, "request_id", "-"),
            "message": record.getMessage(),
        }
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        if record.stack_info:
            entry["stack"] = self.formatStack(record.stack_info)
        return json.dumps(entry, ensure_ascii=False)


# uvicorn gives these their own text handlers (and stops them propagating)
# before it loads the app.
_UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")


def configure_logging(log_format: LogFormat = "text") -> None:
    """Sets up root logging with the request-id filter and format. Call once
    at module import time in main.py, before any loggers are used.

    With "json", uvicorn's own loggers are sent through the same handler:
    otherwise its startup and access lines would stay text in a stream a
    log shipper expects to be JSON on every line."""
    handler = logging.StreamHandler()
    handler.addFilter(RequestIdLogFilter())
    if log_format == "json":
        handler.setFormatter(JsonLogFormatter())
        # Python warnings print straight to stderr; logged, they're JSON too.
        logging.captureWarnings(True)
        for name in _UVICORN_LOGGERS:
            uvicorn_logger = logging.getLogger(name)
            uvicorn_logger.handlers = []
            uvicorn_logger.propagate = True
    else:
        handler.setFormatter(
            logging.Formatter("%(asctime)s [%(request_id)s] %(levelname)s %(name)s: %(message)s")
        )

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [handler]
