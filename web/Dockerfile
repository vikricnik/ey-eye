# syntax=docker/dockerfile:1

FROM node:22-slim AS build

WORKDIR /app

# Separate layer for dependencies so code changes don't invalidate the
# (slower) npm install cache.
COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# ---------------------------------------------------------------------------

FROM nginx:1.27-alpine AS serve

COPY --from=build /app/dist /usr/share/nginx/html

# Runs automatically at container startup (nginx's official image executes
# every script in /docker-entrypoint.d/ before starting) — regenerates
# runtime-config.js from PIPELINE_BASE_URL / PIPELINE_API_KEY environment
# variables, so this same built image works against any server without
# rebuilding. See docker/40-runtime-config.sh.
COPY docker/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh
RUN chmod +x /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 80
