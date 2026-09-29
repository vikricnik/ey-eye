"""
Route modules. This API's own routes, mounted under /v1 by main.py:
discovery.py (GET /v1/server-info, /v1/workflows), runs.py (POST
/v1/workflows/{name}/runs), editing.py (GET/PUT/DELETE /v1/workflows/{name},
models, presets, and the /v1/drafts/… operations on unsaved definitions).
The URLs call pipelines workflows — spec 003's name for them, adopted
before any release; the code, files and JSON fields still say pipeline.
At fixed paths outside it: health.py (GET /health), metrics.py (GET
/metrics, for Prometheus) and openai_compat.py (GET /openai/v1/models,
POST /openai/v1/chat/completions).
main.py imports these directly (`from llm_pipeline.routers import discovery,
editing, health, metrics, openai_compat, runs`) — Python resolves that natively for any
submodule of a package without this __init__ needing to do anything itself.
"""
