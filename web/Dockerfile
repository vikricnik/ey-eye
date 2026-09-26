# syntax=docker/dockerfile:1
#
# Build context is the REPO ROOT (not web/), because the web client depends
# on the npm workspace package @llm-pipeline/client in packages/client:
#   docker build -f web/Dockerfile -t llm-pipeline-web .
# (docker compose does this for you — see the root docker-compose.yml.)
# web/Dockerfile.dockerignore keeps the context small.

FROM node:22-slim AS build

WORKDIR /app

# Dependencies first, in their own layer: every workspace's package.json is
# needed for npm to resolve the workspace, but only web's deps are installed.
COPY package.json package-lock.json ./
COPY packages/client/package.json packages/client/
COPY cli/package.json cli/
COPY web/package.json web/
RUN npm ci --workspace=web

COPY packages/client packages/client
COPY web web
RUN npm run build --workspace=web

# ---------------------------------------------------------------------------

FROM nginx:1.27-alpine AS serve

COPY --from=build /app/web/dist /usr/share/nginx/html

# Runs automatically at container startup (nginx's official image executes
# every script in /docker-entrypoint.d/ before starting) — regenerates
# runtime-config.js from PIPELINE_BASE_URL / PIPELINE_API_KEY environment
# variables, so this same built image works against any server without
# rebuilding. See web/docker/40-runtime-config.sh.
COPY web/docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 80
