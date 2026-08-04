import time
import pytest

from llm_pipeline.rate_limit import RateLimiter


def test_allows_requests_within_limit() -> None:
    limiter = RateLimiter(requests_per_window=3, window_seconds=60.0)
    for _ in range(3):
        limiter.check("client-a")  # should not raise


def test_rejects_requests_over_limit() -> None:
    from fastapi import HTTPException

    limiter = RateLimiter(requests_per_window=2, window_seconds=60.0)
    limiter.check("client-a")
    limiter.check("client-a")

    with pytest.raises(HTTPException) as exc_info:
        limiter.check("client-a")
    assert exc_info.value.status_code == 429
    # HTTPException.headers is typed Optional — narrow before using `in`,
    # since None doesn't support __contains__.
    assert exc_info.value.headers is not None
    assert "Retry-After" in exc_info.value.headers


def test_different_clients_tracked_independently() -> None:
    limiter = RateLimiter(requests_per_window=1, window_seconds=60.0)
    limiter.check("client-a")
    limiter.check("client-b")  # different client — should not raise


def test_window_expiry_allows_requests_again() -> None:
    limiter = RateLimiter(requests_per_window=1, window_seconds=0.2)
    limiter.check("client-a")

    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        limiter.check("client-a")

    time.sleep(0.25)
    limiter.check("client-a")  # window elapsed — should succeed again
