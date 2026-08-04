"""
Every error response — success responses live in the routers. This module
owns the ErrorResponse contract end to end: the three exception handlers
that build it, the shared builder they all call, and the OpenAPI
`responses={...}` map endpoints use to document which error shapes they
can return (purely descriptive — the handlers below enforce the shape at
runtime regardless of what's declared per-endpoint).
"""

import logging
from datetime import datetime, timezone
from http import HTTPStatus

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from llm_pipeline.api_schemas import ErrorResponse, ValidationIssue
from llm_pipeline.logging_context import get_request_id

logger: logging.Logger = logging.getLogger("llm_pipeline")


def _reason_phrase(status_code: int) -> str:
    try:
        return HTTPStatus(status_code).phrase
    except ValueError:
        return "Error"


def build_error_response(
    request: Request,
    status_code: int,
    message: str,
    details: dict[str, object] | None = None,
    validations: list[ValidationIssue] | None = None,
) -> ErrorResponse:
    """The one place every error field gets populated, so all three handlers
    registered below produce byte-for-byte the same shape."""
    return ErrorResponse(
        timestamp=datetime.now(timezone.utc),
        status=status_code,
        error=_reason_phrase(status_code),
        message=message,
        request=f"{request.method} {request.url.path}",
        exceptionUID=get_request_id(),
        details=details or {},
        validations=validations or [],
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Registers all three handlers on the given app. Called once from
    main.py at app creation."""

    @app.exception_handler(HTTPException)
    async def http_exception_handler(  # pyright: ignore[reportUnusedFunction]
        request: Request, exc: HTTPException
    ) -> JSONResponse:
        """Every HTTPException raised anywhere (endpoints, or Depends()
        dependencies like require_api_key/enforce_rate_limit) is caught here
        exactly once. Forwards exc.headers so the rate limiter's `Retry-After`
        header still reaches the client, and mirrors it into `details` too
        since that's the one piece of already-structured extra data a plain
        HTTPException carries.

        (pyright flags this as unused: it can see the `@app.exception_handler`
        decorator is applied, but not that FastAPI's own internal registry is
        what actually "calls" this afterward — the local name itself is never
        referenced again in this function's body. Same false-positive category
        as the pytest autouse fixtures elsewhere in this codebase; the
        decorator's registration side effect IS the usage.)"""
        details: dict[str, object] = {}
        if exc.headers and "Retry-After" in exc.headers:
            details["retry_after_seconds"] = exc.headers["Retry-After"]

        body = build_error_response(request, exc.status_code, str(exc.detail), details=details)
        return JSONResponse(
            status_code=exc.status_code,
            content=body.model_dump(mode="json"),  # mode="json": datetime -> ISO string
            headers=exc.headers,
        )

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(  # pyright: ignore[reportUnusedFunction]
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """FastAPI's automatic 422 (e.g. a malformed AskRequest body) normally
        returns Pydantic's own nested error-list shape. Mapped into the same
        ErrorResponse contract instead — each individual field problem becomes
        one ValidationIssue in `validations`, rather than being flattened away.

        (pyright false positive — see http_exception_handler's docstring above
        for why.)"""
        validations = [
            ValidationIssue(
                field=".".join(str(loc) for loc in e["loc"]),
                message=e["msg"],
                type=e["type"],
            )
            for e in exc.errors()
        ]
        body = build_error_response(
            request, 422, "Request validation failed", validations=validations
        )
        return JSONResponse(status_code=422, content=body.model_dump(mode="json"))

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(  # pyright: ignore[reportUnusedFunction]
        request: Request, exc: Exception
    ) -> JSONResponse:
        """Catches anything not already handled above — a genuine bug slipping
        past the error handling this codebase explicitly anticipates. Without
        this, an unexpected exception would fall through to FastAPI's default
        handler and NOT match the ErrorResponse contract; with it, every
        possible error path — anticipated or not — returns the same shape.

        (pyright false positive — see http_exception_handler's docstring above
        for why.)"""
        logger.exception("Unhandled exception")
        body = build_error_response(request, 500, "Internal server error")
        return JSONResponse(status_code=500, content=body.model_dump(mode="json"))


# Documents the error shape in OpenAPI for every status code an endpoint can
# actually raise — purely descriptive.
ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    400: {"model": ErrorResponse, "description": "Invalid input"},
    401: {"model": ErrorResponse, "description": "Missing or invalid API key"},
    404: {"model": ErrorResponse, "description": "Pipeline not found"},
    422: {"model": ErrorResponse, "description": "Request body failed validation"},
    429: {"model": ErrorResponse, "description": "Rate limit exceeded"},
    502: {"model": ErrorResponse, "description": "Unexpected pipeline error"},
    503: {"model": ErrorResponse, "description": "Pipeline tier fully failed"},
    500: {"model": ErrorResponse, "description": "Unhandled server error"},
}
