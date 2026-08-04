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

import time
import logging
from collections import defaultdict, deque

from fastapi import Header, HTTPException, Request

from llm_pipeline.settings import settings

logger: logging.Logger = logging.getLogger("llm_pipeline")

WINDOW_SECONDS = 60.0


class RateLimiter:
    def __init__(self, requests_per_window: int, window_seconds: float = WINDOW_SECONDS) -> None:
        self.requests_per_window = requests_per_window
        self.window_seconds = window_seconds
        # client_id -> deque of request timestamps within the current window
        self._requests: dict[str, deque[float]] = defaultdict(deque)

    def check(self, client_id: str) -> None:
        """Raises HTTPException(429) if client_id is over the limit;
        otherwise records this request and returns."""
        now = time.monotonic()
        history = self._requests[client_id]

        while history and now - history[0] > self.window_seconds:
            history.popleft()

        if len(history) >= self.requests_per_window:
            retry_after = self.window_seconds - (now - history[0])
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Rate limit exceeded: {self.requests_per_window} requests per "
                    f"{int(self.window_seconds)}s. Retry in {retry_after:.0f}s."
                ),
                headers={"Retry-After": str(max(1, int(retry_after)))},
            )

        history.append(now)


# Module-level singleton — shared across requests within one process, which
# is exactly what we want for a per-process fixed-window counter.
_limiter = RateLimiter(settings.rate_limit_requests_per_minute)


def _client_identifier(
    request: Request, authorization: str | None, x_api_key: str | None
) -> str:
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
