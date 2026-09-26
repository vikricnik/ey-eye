# syntax=docker/dockerfile:1
#
# NOTE: this is an interactive terminal REPL (readline-based), which is a
# genuinely weaker fit for Docker than the web client's static-site build —
# see the project README for the full reasoning. Prefer `npm install && npm
# start` locally unless you have a specific reason to containerize this
# (e.g. running it from a machine without Node, or from CI).
#
# Build context is the REPO ROOT (not cli/), because the CLI depends on the
# npm workspace package @llm-pipeline/client in packages/client:
#   docker build -f cli/Dockerfile -t llm-pipeline-cli .
#
# Running it requires -it for a working TTY:
#   docker run -it --rm \
#     -e PIPELINE_BASE_URL=http://host.docker.internal:8000 \
#     llm-pipeline-cli
#
# `host.docker.internal` reaches a pipeline server running on your host
# machine (outside Docker). If the server is ALSO a container on the same
# docker-compose network, use that service's name instead
# (e.g. PIPELINE_BASE_URL=http://pipeline-server:8000) and add
# `--network <compose-project>_default` to the run command.

FROM node:22-slim

WORKDIR /app

# Every workspace's package.json is needed for npm to resolve the
# workspace; only the CLI's dependencies (including tsx) are installed.
COPY package.json package-lock.json ./
COPY packages/client/package.json packages/client/
COPY cli/package.json cli/
COPY web/package.json web/
RUN npm ci --workspace=cli

COPY packages/client packages/client
COPY cli cli

# Runs from TypeScript source through tsx — the same as `npm start`. The
# shared client package ships as TypeScript source, so a tsc-compiled
# dist/ can't be run by plain `node`.
WORKDIR /app/cli
ENTRYPOINT ["node", "--import", "tsx", "src/index.ts"]
