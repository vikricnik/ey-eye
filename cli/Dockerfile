# syntax=docker/dockerfile:1
#
# NOTE: this is an interactive terminal REPL (readline-based), which is a
# genuinely weaker fit for Docker than the web client's static-site build —
# see the project README for the full reasoning. Prefer `npm install && npm
# start` locally unless you have a specific reason to containerize this
# (e.g. running it from a machine without Node, or from CI).
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

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

ENTRYPOINT ["node", "dist/index.js"]
