"""
ApiError — the HTTPException this API raises: it names its ErrorCode, so a
client can tell apart failures that share a status. Kept out of
error_handling.py so that code raising errors (auth, rate limiting, the
routers) doesn't depend on the handlers that render them.
"""

from fastapi import HTTPException

from llm_pipeline.api_schemas import ErrorCode


class ApiError(HTTPException):
    def __init__(
        self,
        status_code: int,
        code: ErrorCode,
        message: str,
        *,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(status_code=status_code, detail=message, headers=headers)
        self.code = code
