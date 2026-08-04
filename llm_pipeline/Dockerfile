# syntax=docker/dockerfile:1

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    POETRY_NO_INTERACTION=1 \
    POETRY_VIRTUALENVS_IN_PROJECT=1

WORKDIR /app

RUN pip install --no-cache-dir poetry

# Install dependencies in a separate layer so code changes don't invalidate
# the (slow) dependency install cache.
COPY pyproject.toml poetry.lock* ./
RUN poetry install --no-interaction --no-root --only main

# --extras can be added at build time if you need cloud providers, e.g.:
#   docker build --build-arg POETRY_EXTRAS="openai anthropic" .
ARG POETRY_EXTRAS=""
RUN if [ -n "$POETRY_EXTRAS" ]; then poetry install --no-interaction --no-root --only main --extras "$POETRY_EXTRAS"; fi

COPY llm_pipeline/ ./llm_pipeline/
COPY pipelines/ ./pipelines/

# Re-run install to register the project itself (the --no-root install
# above only installed dependencies).
RUN poetry install --no-interaction --only main

EXPOSE 8000

# Pipelines are baked into the image (see root README: "no arbitrary YAML
# upload" is a deliberate security boundary) — changing a pipeline means
# rebuilding the image, same as any other code change.
CMD ["poetry", "run", "uvicorn", "llm_pipeline.main:app", "--host", "0.0.0.0", "--port", "8000"]
