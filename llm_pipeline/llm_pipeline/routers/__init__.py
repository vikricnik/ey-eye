"""
Route modules: health.py (GET /health, /pipelines, /pipelines/{name}),
ask.py (POST /ask). main.py imports these directly
(`from llm_pipeline.routers import health, ask`) — Python resolves that
natively for any submodule of a package without this __init__ needing to
do anything itself.
"""

