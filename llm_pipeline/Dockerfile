# syntax=docker/dockerfile:1

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

WORKDIR /app

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

# Extras can be added at build time if you need cloud providers, e.g.:
#   docker build --build-arg UV_EXTRAS="openai anthropic" .
# Declared before both sync layers below and reused identically in each —
# unlike `poetry install`, `uv sync` always prunes the environment down to
# exactly what's requested, so a build with extras that only passed
# `--extra` on the first layer would have them silently uninstalled again
# by the second (project-registration) sync.
ARG UV_EXTRAS=""

# Install dependencies in a separate layer so code changes don't invalidate
# the (slow) dependency install cache.
COPY pyproject.toml uv.lock* ./
RUN EXTRA_ARGS=""; \
    for extra in $UV_EXTRAS; do EXTRA_ARGS="$EXTRA_ARGS --extra $extra"; done; \
    uv sync --locked --no-install-project --no-dev $EXTRA_ARGS

COPY llm_pipeline/ ./llm_pipeline/
COPY pipelines/ ./pipelines/
COPY README.md ./

# Re-run sync to register the project itself (the --no-install-project sync
# above only installed dependencies). This step reads pyproject.toml's
# `readme = "README.md"` field, so README.md must exist in the build
# context by this point — that's what the COPY above is for.
RUN EXTRA_ARGS=""; \
    for extra in $UV_EXTRAS; do EXTRA_ARGS="$EXTRA_ARGS --extra $extra"; done; \
    uv sync --locked --no-dev $EXTRA_ARGS

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 8000

# Pipelines are baked into the image (see root README: "no arbitrary YAML
# upload" is a deliberate security boundary) — changing a pipeline means
# rebuilding the image, same as any other code change.
CMD ["uvicorn", "llm_pipeline.main:app", "--host", "0.0.0.0", "--port", "8000"]
