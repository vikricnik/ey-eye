"""
Route modules: health.py (GET /health, /pipelines, /pipelines/{name}),
ask.py (POST /ask, /ask/stream), editing.py (models, full definitions,
validate/import/export, saving, presets — for editor clients),
openai_compat.py (GET /openai/v1/models, POST /openai/v1/chat/completions).
main.py imports these directly (`from llm_pipeline.routers import ask,
editing, health, openai_compat`) — Python resolves that natively for any
submodule of a package without this __init__ needing to do anything itself.
"""
