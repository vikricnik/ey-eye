"""
Route modules: health.py (GET /health, /pipelines), runs.py (POST
/pipelines/{name}/runs), editing.py (GET/PUT/DELETE /pipelines/{name},
models, presets, and the /drafts/… operations on unsaved definitions),
openai_compat.py (GET /openai/v1/models, POST /openai/v1/chat/completions).
main.py imports these directly (`from llm_pipeline.routers import editing,
health, openai_compat, runs`) — Python resolves that natively for any
submodule of a package without this __init__ needing to do anything itself.
"""
