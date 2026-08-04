import pytest
from fastapi import HTTPException

from llm_pipeline import auth
from llm_pipeline.settings import settings

# NOTE: `settings` is imported directly from where it's actually defined
# (llm_pipeline.settings), not accessed via `auth.settings` — mypy's
# no_implicit_reexport (part of strict=true) flags accessing a name through
# a module that merely imported it without explicitly re-exporting it.
# Monkeypatching this `settings` object works identically either way at
# runtime, since it's the same singleton instance auth.py holds a reference
# to — mutating an attribute on it is visible everywhere that reference is
# used, regardless of which import path was used to get a handle on it.


@pytest.mark.asyncio
async def test_auth_disabled_when_no_keys_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "api_keys", "")
    # Should not raise, even with no credentials presented at all.
    await auth.require_api_key(authorization=None, x_api_key=None)


@pytest.mark.asyncio
async def test_valid_bearer_token_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "api_keys", "secret-key-1,secret-key-2")
    await auth.require_api_key(authorization="Bearer secret-key-1", x_api_key=None)
    await auth.require_api_key(authorization="Bearer secret-key-2", x_api_key=None)


@pytest.mark.asyncio
async def test_valid_x_api_key_header_accepted(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "api_keys", "secret-key-1")
    await auth.require_api_key(authorization=None, x_api_key="secret-key-1")


@pytest.mark.asyncio
async def test_missing_credentials_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "api_keys", "secret-key-1")
    with pytest.raises(HTTPException) as exc_info:
        await auth.require_api_key(authorization=None, x_api_key=None)
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_wrong_key_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "api_keys", "secret-key-1")
    with pytest.raises(HTTPException) as exc_info:
        await auth.require_api_key(authorization="Bearer wrong-key", x_api_key=None)
    assert exc_info.value.status_code == 401


@pytest.mark.asyncio
async def test_x_api_key_takes_precedence_over_bearer(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "api_keys", "secret-key-1")
    # x_api_key is checked first in _extract_key; a wrong Authorization
    # header alongside a valid X-API-Key should still succeed.
    await auth.require_api_key(authorization="Bearer wrong-key", x_api_key="secret-key-1")
