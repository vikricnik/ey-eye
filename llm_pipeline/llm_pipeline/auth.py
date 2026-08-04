"""
API key authentication.

Deliberately simple: a shared-secret header check, not a full auth system
(no user accounts, no OAuth, no per-key scopes). That's a reasonable v1 for
a single-team internal service; if this ever needs multi-tenant access
control, this module is the one place that would need replacing.

If `settings.api_keys` is empty (the default), auth is disabled entirely —
every request passes through. A warning is logged once at startup so this
is visible rather than silently permissive. Set `API_KEYS` to enable it.
"""

import logging
import secrets

from fastapi import Header, HTTPException

from llm_pipeline.settings import settings

logger: logging.Logger = logging.getLogger("llm_pipeline")

_warned_no_auth = False


def _warn_once_if_auth_disabled() -> None:
    global _warned_no_auth
    if not settings.api_keys_list and not _warned_no_auth:
        logger.warning(
            "API_KEYS is not set — /ask and /pipelines/* are running with NO "
            "authentication. Anyone who can reach this server can run any "
            "pipeline. Set API_KEYS (comma-separated) to enable auth."
        )
        _warned_no_auth = True


def _extract_key(authorization: str | None, x_api_key: str | None) -> str | None:
    if x_api_key:
        return x_api_key
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[len("Bearer ") :].strip()
    return None


async def require_api_key(
    authorization: str | None = Header(default=None),
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> None:
    """FastAPI dependency: raises 401 unless a valid key is presented via
    either `Authorization: Bearer <key>` or `X-API-Key: <key>`.

    Uses secrets.compare_digest for the comparison — a plain `==` on
    attacker-controlled input is a timing side-channel (early-exit string
    comparison leaks how many leading characters matched); this is a
    standard, cheap precaution for exactly this kind of shared-secret check.
    """
    _warn_once_if_auth_disabled()

    configured_keys = settings.api_keys_list
    if not configured_keys:
        return  # auth disabled — see the startup warning above

    presented = _extract_key(authorization, x_api_key)
    if presented is None:
        raise HTTPException(
            status_code=401,
            detail="Missing API key — provide 'Authorization: Bearer <key>' or 'X-API-Key: <key>'",
        )

    for valid_key in configured_keys:
        if secrets.compare_digest(presented, valid_key):
            return

    raise HTTPException(status_code=401, detail="Invalid API key")
