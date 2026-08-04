"""
Request correlation IDs for structured logging.

Without this, concurrent requests' log lines interleave with no way to tell
which lines belong to which request. This gives every request a short id
(reused from the client's X-Request-ID header if provided, otherwise
generated), stashes it in a contextvar, and injects it into every log
record automatically via a logging.Filter — so existing `logger.info(...)`
calls throughout dag_builder.py etc. don't need to change at all to start
including it.
"""

import logging
import uuid
from contextvars import ContextVar
from collections.abc import Awaitable, Callable

from fastapi import Request, Response

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


def configure_logging() -> None:
    """Sets up root logging with the request-id filter and format. Call once
    at module import time in main.py, before any loggers are used."""
    handler = logging.StreamHandler()
    handler.addFilter(RequestIdLogFilter())
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(request_id)s] %(levelname)s %(name)s: %(message)s")
    )

    root = logging.getLogger()
    root.setLevel(logging.INFO)
    root.handlers = [handler]
