"""
In-process rate limiting — a fixed-window counter per client.

Deliberately simple and dependency-free (no Redis, no slowapi). This is
correct and sufficient for a SINGLE server process. If you scale to multiple
instances behind a load balancer, each instance enforces its own limit
independently — a client could get up to N_instances * limit through in
total. Fine for a first pass; swap in a shared store (Redis INCR + EXPIRE is
the standard pattern) if you actually run multiple instances and need a
hard global cap.
"""

import logging
import time
from collections import defaultdict, deque

from fastapi import Header, Request

from llm_pipeline import metrics
from llm_pipeline.api_error import ApiError
from llm_pipeline.api_schemas import ErrorCode
from llm_pipeline.settings import settings

logger: logging.Logger = logging.getLogger("llm_pipeline")

WINDOW_SECONDS = 60.0


class RateLimiter:
    def __init__(self, requests_per_window: int, window_seconds: float = WINDOW_SECONDS) -> None:
        self.requests_per_window = requests_per_window
        self.window_seconds = window_seconds
        # client_id -> deque of request timestamps within the current window
        self._requests: dict[str, deque[float]] = defaultdict(deque)
        # When clients with no request inside the window are next forgotten.
        self._next_sweep_at = time.monotonic() + window_seconds

    @property
    def tracked_clients(self) -> int:
        """How many clients request history is held for — at most those
        seen within the last two windows (see _forget_idle_clients)."""
        return len(self._requests)

    def check(self, client_id: str) -> None:
        """Raises ApiError(RATE_LIMITED) if client_id is over the limit;
        otherwise records this request and returns."""
        now = time.monotonic()
        if now >= self._next_sweep_at:
            self._forget_idle_clients(now)
        history = self._requests[client_id]

        while history and now - history[0] > self.window_seconds:
            history.popleft()

        if len(history) >= self.requests_per_window:
            metrics.count_rate_limited()
            retry_after = self.window_seconds - (now - history[0])
            raise ApiError(
                ErrorCode.RATE_LIMITED,
                (
                    f"Rate limit exceeded: {self.requests_per_window} requests per "
                    f"{int(self.window_seconds)}s. Retry in {retry_after:.0f}s."
                ),
                headers={"Retry-After": str(max(1, int(retry_after)))},
            )

        history.append(now)

    def _forget_idle_clients(self, now: float) -> None:
        """Drops every client with no request inside the window. Its history
        would be pruned to nothing on its next request anyway — but a client
        that never comes back (with auth off, every IP that ever connected)
        would otherwise be kept for the life of the process. Pruning only in
        check() can't catch those: it only ever visits the client asking.
        Runs at most once per window, so a request pays O(1) on average."""
        idle = [
            client_id
            for client_id, history in self._requests.items()
            if not history or now - history[-1] > self.window_seconds
        ]
        for client_id in idle:
            del self._requests[client_id]
        self._next_sweep_at = now + self.window_seconds


# Module-level singleton — shared across requests within one process, which
# is exactly what we want for a per-process fixed-window counter.
_limiter = RateLimiter(settings.rate_limit_requests_per_minute)


def _client_identifier(request: Request, authorization: str | None, x_api_key: str | None) -> str:
    """Rate limit by API key if auth is configured (so the limit tracks the
    caller, not whatever IP they happen to connect from); fall back to
    client IP if auth is disabled."""
    if x_api_key:
        return f"key:{x_api_key}"
    if authorization and authorization.lower().startswith("bearer "):
        return f"key:{authorization[len('Bearer '):].strip()}"
    client_host = request.client.host if request.client else "unknown"
    return f"ip:{client_host}"


async def enforce_rate_limit(
    request: Request,
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> None:
    """FastAPI dependency: raises 429 if this client has exceeded
    `settings.rate_limit_requests_per_minute` requests in the last 60s."""
    client_id = _client_identifier(request, authorization, x_api_key)
    _limiter.check(client_id)
