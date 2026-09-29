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


def test_clients_that_went_quiet_are_forgotten() -> None:
    """With auth off, clients are keyed by IP: a limiter that kept every
    client it had ever seen would grow for as long as the process runs."""
    limiter = RateLimiter(requests_per_window=5, window_seconds=0.1)
    for i in range(50):
        limiter.check(f"ip:10.0.0.{i}")
    assert limiter.tracked_clients == 50

    time.sleep(0.25)  # every one of them is now past the window
    limiter.check("ip:10.0.1.1")
    assert limiter.tracked_clients == 1


def test_forgetting_idle_clients_never_resets_an_active_clients_limit() -> None:
    limiter = RateLimiter(requests_per_window=1, window_seconds=0.3)
    time.sleep(0.2)
    limiter.check("client-a")  # still inside its window at the sweep below
    time.sleep(0.15)
    limiter.check("client-b")  # past the first sweep time: idle clients go

    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        limiter.check("client-a")
