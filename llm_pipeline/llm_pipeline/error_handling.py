"""
Every error response — success responses live in the routers. This module
owns the ErrorResponse contract end to end: the exception handlers that
build it, the shared builders they all call, and the OpenAPI
`responses={...}` map endpoints use to document which error shapes they
can return (purely descriptive — the handlers below enforce the shape at
runtime regardless of what's declared per-endpoint).

The one exception is routers/openai_compat.py: its routes answer in
OpenAI's error shape instead, converting the same ErrorResponse built here.
That router opts in itself (see OpenAIErrorRoute) — the handlers below
never look at the request path, so no other route can end up in OpenAI's
shape by where it is mounted.
"""

import logging
from collections.abc import Mapping
from datetime import UTC, datetime
from http import HTTPStatus

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from llm_pipeline.api_error import STATUS_BY_CODE, ApiError
from llm_pipeline.api_schemas import ErrorCode, ErrorResponse, ValidationIssue
from llm_pipeline.errors import (
    AlreadyExistsError,
    DefinitionInvalidError,
    InvalidNameError,
    ProtectedPipelineError,
    RevisionConflictError,
)
from llm_pipeline.logging_context import get_request_id
from llm_pipeline.model_catalog import ModelNotAllowedError

logger: logging.Logger = logging.getLogger("llm_pipeline")


def _reason_phrase(status_code: int) -> str:
    try:
        return HTTPStatus(status_code).phrase
    except ValueError:
        return "Error"


def build_error_response(
    request: Request,
    code: ErrorCode,
    message: str,
    *,
    details: dict[str, object] | None = None,
    validations: list[ValidationIssue] | None = None,
    status_code: int | None = None,
) -> ErrorResponse:
    """The one place every error field gets populated, so all the handlers
    registered below produce byte-for-byte the same shape. The status is the
    code's (STATUS_BY_CODE); `status_code` overrides it only for an
    HTTPException this API didn't raise, which has a status of its own."""
    if status_code is None:
        status_code = STATUS_BY_CODE[code]
    return ErrorResponse(
        timestamp=datetime.now(UTC),
        status=status_code,
        error=_reason_phrase(status_code),
        code=code,
        message=message,
        request=f"{request.method} {request.url.path}",
        exceptionUID=get_request_id(),
        details=details or {},
        validations=validations or [],
    )


def error_response_from_http_exception(request: Request, exc: HTTPException) -> ErrorResponse:
    """Mirrors a `Retry-After` header into `details` too, since that's the
    one piece of already-structured extra data a plain HTTPException
    carries. The header itself still has to be forwarded by the caller.

    This API raises ApiError, which names its code and may carry details. A
    bare HTTPException (from a library, say) keeps its own status and only
    gets a generic code."""
    details: dict[str, object] = {}
    if exc.headers and "Retry-After" in exc.headers:
        details["retry_after_seconds"] = exc.headers["Retry-After"]
    if isinstance(exc, ApiError):
        return build_error_response(
            request, exc.code, str(exc.detail), details={**exc.details, **details}
        )
    code = ErrorCode.INTERNAL_ERROR if exc.status_code >= 500 else ErrorCode.REQUEST_INVALID
    return build_error_response(
        request, code, str(exc.detail), details=details, status_code=exc.status_code
    )


def error_response_from_validation_error(
    request: Request, exc: RequestValidationError
) -> ErrorResponse:
    """FastAPI's automatic 422 (e.g. a malformed RunRequest body) normally
    returns Pydantic's own nested error-list shape. Mapped into the same
    ErrorResponse contract instead — each individual field problem becomes
    one ValidationIssue in `validations`, rather than being flattened away."""
    validations = [
        ValidationIssue(
            field=".".join(str(loc) for loc in e["loc"]),
            message=e["msg"],
            type=e["type"],
        )
        for e in exc.errors()
    ]
    return build_error_response(
        request, ErrorCode.REQUEST_INVALID, "Request validation failed", validations=validations
    )


def _respond(body: ErrorResponse, headers: Mapping[str, str] | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=body.status,
        content=body.model_dump(mode="json"),  # mode="json": datetime -> ISO string
        headers=headers,
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Registers every handler on the given app. Called once from main.py
    at app creation."""

    @app.exception_handler(HTTPException)
    async def http_exception_handler(  # pyright: ignore[reportUnusedFunction]
        request: Request, exc: HTTPException
    ) -> JSONResponse:
        """Every HTTPException raised anywhere (endpoints, or Depends()
        dependencies like require_api_key/enforce_rate_limit) is caught here
        exactly once. Forwards exc.headers so the rate limiter's `Retry-After`
        header still reaches the client.

        (pyright flags this as unused: it can see the `@app.exception_handler`
        decorator is applied, but not that FastAPI's own internal registry is
        what actually "calls" this afterward — the local name itself is never
        referenced again in this function's body. Same false-positive category
        as the pytest autouse fixtures elsewhere in this codebase; the
        decorator's registration side effect IS the usage.)"""
        return _respond(error_response_from_http_exception(request, exc), exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(  # pyright: ignore[reportUnusedFunction]
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        """See error_response_from_validation_error.

        (pyright false positive — see http_exception_handler's docstring above
        for why.)"""
        return _respond(error_response_from_validation_error(request, exc))

    @app.exception_handler(DefinitionInvalidError)
    async def definition_invalid_handler(  # pyright: ignore[reportUnusedFunction]
        request: Request, exc: DefinitionInvalidError
    ) -> JSONResponse:
        """A client-submitted pipeline/preset failed validation. `details`
        names the node an editor should highlight when one is at fault;
        `validations` carries every individual problem pydantic reported.

        (pyright false positive — see http_exception_handler's docstring.)"""
        details: dict[str, object] = {"node_id": exc.node_id} if exc.node_id else {}
        validations = [
            ValidationIssue(field=location, message=message, type=error_type)
            for location, message, error_type in exc.issues
        ]
        return _respond(
            build_error_response(
                request,
                ErrorCode.DEFINITION_INVALID,
                str(exc),
                details=details,
                validations=validations,
            )
        )

    @app.exception_handler(ModelNotAllowedError)
    async def model_not_allowed_handler(  # pyright: ignore[reportUnusedFunction]
        request: Request, exc: ModelNotAllowedError
    ) -> JSONResponse:
        """(pyright false positive — see http_exception_handler's docstring.)"""
        details: dict[str, object] = {"node_id": exc.node_id} if exc.node_id else {}
        return _respond(
            build_error_response(request, ErrorCode.MODEL_NOT_ALLOWED, str(exc), details=details)
        )

    @app.exception_handler(RevisionConflictError)
    @app.exception_handler(ProtectedPipelineError)
    async def conflict_handler(  # pyright: ignore[reportUnusedFunction]
        request: Request, exc: Exception
    ) -> JSONResponse:
        """(pyright false positive — see http_exception_handler's docstring.)"""
        if isinstance(exc, AlreadyExistsError):
            code = ErrorCode.ALREADY_EXISTS
        elif isinstance(exc, ProtectedPipelineError):
            code = ErrorCode.PIPELINE_PROTECTED
        else:
            code = ErrorCode.REVISION_CONFLICT
        return _respond(build_error_response(request, code, str(exc)))

    @app.exception_handler(InvalidNameError)
    async def invalid_name_handler(  # pyright: ignore[reportUnusedFunction]
        request: Request, exc: InvalidNameError
    ) -> JSONResponse:
        """(pyright false positive — see http_exception_handler's docstring.)"""
        return _respond(build_error_response(request, ErrorCode.NAME_INVALID, str(exc)))

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
        return _respond(
            build_error_response(request, ErrorCode.INTERNAL_ERROR, "Internal server error")
        )


# Documents the error shape in OpenAPI for every status code an endpoint can
# actually raise — purely descriptive. Each status's codes are in
# STATUS_BY_CODE; `code` says which one it is.
ERROR_RESPONSES: dict[int | str, dict[str, object]] = {
    400: {"model": ErrorResponse, "description": "Unusable input or name"},
    401: {"model": ErrorResponse, "description": "Missing or invalid API key"},
    403: {"model": ErrorResponse, "description": "Pipeline editing is disabled"},
    404: {"model": ErrorResponse, "description": "A pipeline, node, preset, … that doesn't exist"},
    409: {"model": ErrorResponse, "description": "The default pipeline can't be deleted"},
    412: {"model": ErrorResponse, "description": "If-Match / If-None-Match didn't hold"},
    428: {"model": ErrorResponse, "description": "Saving needs If-Match or If-None-Match"},
    422: {"model": ErrorResponse, "description": "Request or submitted definition is invalid"},
    429: {"model": ErrorResponse, "description": "Rate limit exceeded"},
    500: {"model": ErrorResponse, "description": "Unexpected server error"},
    502: {"model": ErrorResponse, "description": "The pipeline run failed"},
}
