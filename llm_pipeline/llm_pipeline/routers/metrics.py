"""
GET /metrics — the metrics in metrics.py, in Prometheus' text format.

Behind the API key: its labels name pipelines and models, which is what
/v1/workflows needs a key for, so it can't be open the way /health is.
Prometheus sends the key with `authorization: {credentials: <key>}` (or
`bearer_token`) in its scrape config. Not rate limited: a scrape answered
with 429 leaves a gap in every graph and alert built on it. Left out of the
OpenAPI schema — it's for the scraper, not for API clients.
"""

from fastapi import APIRouter, Depends, Response

from llm_pipeline import metrics
from llm_pipeline.auth import require_api_key

router = APIRouter()


@router.get("/metrics", include_in_schema=False, dependencies=[Depends(require_api_key)])
async def get_metrics() -> Response:
    return Response(metrics.exposition(), media_type=metrics.CONTENT_TYPE)
