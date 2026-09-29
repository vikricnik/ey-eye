"""
Route modules. This API's own routes, mounted under /v1 by main.py:
discovery.py (GET /v1/server-info, /v1/pipelines), runs.py (POST
/v1/pipelines/{name}/runs), editing.py (GET/PUT/DELETE /v1/pipelines/{name},
models, presets, and the /v1/drafts/… operations on unsaved definitions).
At fixed paths outside it: health.py (GET /health), metrics.py (GET
/metrics, for Prometheus) and openai_compat.py (GET /openai/v1/models,
POST /openai/v1/chat/completions).
main.py imports these directly (`from llm_pipeline.routers import discovery,
editing, health, metrics, openai_compat, runs`) — Python resolves that natively for any
submodule of a package without this __init__ needing to do anything itself.
"""
