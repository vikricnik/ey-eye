#!/bin/sh
set -e

# The official nginx image automatically runs every executable script in
# /docker-entrypoint.d/ before starting nginx — this file is copied there
# by the Dockerfile. Runs at CONTAINER STARTUP, not build time, so the same
# built image can be pointed at a different pipeline server (or given a
# different API key) per deployment without rebuilding.
cat > /usr/share/nginx/html/runtime-config.js << CONFIG
window.PIPELINE_BASE_URL = "${PIPELINE_BASE_URL:-http://localhost:8000}";
window.PIPELINE_API_KEY = "${PIPELINE_API_KEY:-}";
CONFIG

echo "runtime-config.js written: PIPELINE_BASE_URL=${PIPELINE_BASE_URL:-http://localhost:8000}"
