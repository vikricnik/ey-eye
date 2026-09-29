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
    now = [0.0]  # the limiter's clock, moved on by hand
    limiter = RateLimiter(requests_per_window=1, window_seconds=60, clock=lambda: now[0])
    limiter.check("client-a")

    from fastapi import HTTPException

    now[0] = 59.9
    with pytest.raises(HTTPException):
        limiter.check("client-a")  # still inside the window

    now[0] = 60.1
    limiter.check("client-a")  # window elapsed — should succeed again


def test_clients_that_went_quiet_are_forgotten() -> None:
    """With auth off, clients are keyed by IP: a limiter that kept every
    client it had ever seen would grow for as long as the process runs."""
    now = [0.0]
    limiter = RateLimiter(requests_per_window=5, window_seconds=60, clock=lambda: now[0])
    for i in range(50):
        limiter.check(f"ip:10.0.0.{i}")
    assert limiter.tracked_clients == 50

    now[0] = 60.1  # every one of them is now past the window
    limiter.check("ip:10.0.1.1")
    assert limiter.tracked_clients == 1


def test_forgetting_idle_clients_never_resets_an_active_clients_limit() -> None:
    now = [0.0]
    limiter = RateLimiter(requests_per_window=1, window_seconds=60, clock=lambda: now[0])
    now[0] = 40.0
    limiter.check("client-a")  # still inside its window at the sweep below
    now[0] = 70.0
    limiter.check("client-b")  # past the first sweep time: idle clients go

    from fastapi import HTTPException

    with pytest.raises(HTTPException):
        limiter.check("client-a")


def test_a_rate_limit_below_one_is_refused_at_startup(monkeypatch: pytest.MonkeyPatch) -> None:
    """0 used to crash every request with a 500 instead: an empty history
    already counts as over the limit, and working out when to retry reads
    its first entry."""
    from pydantic import ValidationError

    from llm_pipeline.settings import Settings

    for value in ("0", "-5"):
        monkeypatch.setenv("RATE_LIMIT_REQUESTS_PER_MINUTE", value)
        with pytest.raises(ValidationError, match="rate_limit_requests_per_minute"):
            Settings()
    monkeypatch.setenv("RATE_LIMIT_REQUESTS_PER_MINUTE", "1")
    assert Settings().rate_limit_requests_per_minute == 1
