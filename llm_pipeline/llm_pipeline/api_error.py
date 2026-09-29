"""
ApiError — the HTTPException this API raises: it names its ErrorCode, so a
client can tell apart failures that share a status. Kept out of
error_handling.py so that code raising errors (auth, rate limiting, the
routers) doesn't depend on the handlers that render them.
"""

from fastapi import HTTPException

from llm_pipeline.api_schemas import ErrorCode

# The one status each code is sent with — so a client that knows the code
# knows the status, and a raise site can't pick a different one. A request
# naming something that doesn't exist is a 404 wherever the name appears
# (path or body), as OpenAI's API does for an unknown `model`.
STATUS_BY_CODE: dict[ErrorCode, int] = {
    ErrorCode.REQUEST_INVALID: 422,
    ErrorCode.UNAUTHENTICATED: 401,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.INTERNAL_ERROR: 500,
    ErrorCode.NAME_INVALID: 400,
    ErrorCode.PIPELINE_NOT_FOUND: 404,
    ErrorCode.PRESET_NOT_FOUND: 404,
    ErrorCode.MODEL_NOT_FOUND: 404,
    ErrorCode.DEFINITION_INVALID: 422,
    ErrorCode.MODEL_NOT_ALLOWED: 422,
    ErrorCode.EDITING_DISABLED: 403,
    # A write's If-None-Match / If-Match didn't hold (412), or was missing (428).
    ErrorCode.ALREADY_EXISTS: 412,
    ErrorCode.REVISION_CONFLICT: 412,
    ErrorCode.PRECONDITION_REQUIRED: 428,
    ErrorCode.PIPELINE_PROTECTED: 409,
    ErrorCode.INPUT_INVALID: 400,
    ErrorCode.INPUT_TOO_LARGE: 400,
    ErrorCode.NODE_NOT_FOUND: 404,
    ErrorCode.TEST_CASE_NOT_FOUND: 404,
    ErrorCode.TEMPLATE_RENDER_FAILED: 422,
    ErrorCode.PIPELINE_RUN_FAILED: 502,  # the models behind the run failed it
    ErrorCode.RUN_TIMED_OUT: 504,  # the models behind the run took too long
    ErrorCode.REQUEST_CANCELLED: 499,
}


class ApiError(HTTPException):
    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        details: dict[str, object] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(status_code=STATUS_BY_CODE[code], detail=message, headers=headers)
        self.code = code
        self.details: dict[str, object] = details or {}
