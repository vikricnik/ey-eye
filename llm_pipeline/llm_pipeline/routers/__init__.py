"""
Route modules: health.py (GET /health, /pipelines), ask.py (POST /ask,
/ask/stream), editing.py (GET/PUT/DELETE /pipelines/{name}, models,
validate/import/export, presets),
openai_compat.py (GET /openai/v1/models, POST /openai/v1/chat/completions).
main.py imports these directly (`from llm_pipeline.routers import ask,
editing, health, openai_compat`) — Python resolves that natively for any
submodule of a package without this __init__ needing to do anything itself.
"""
