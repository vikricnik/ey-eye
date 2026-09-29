"""
GET /health — open, and unversioned: load balancers and orchestrators probe
it at a fixed path, without credentials. What a client reads to start
(/v1/server-info, /v1/pipelines) is discovery.py's.
"""

from fastapi import APIRouter

from llm_pipeline.api_schemas import HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    # Deliberately NOT behind auth/rate-limit — load balancers and
    # orchestrators typically probe this without credentials. So it tells
    # them only that the server is up: anything else is /v1/server-info's.
    return HealthResponse()
