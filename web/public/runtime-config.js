// Default values for local development (npm run dev) — window.PIPELINE_BASE_URL
// and window.PIPELINE_API_KEY already fall back sensibly if left unset here.
//
// In Docker deployments, this exact file is OVERWRITTEN at container
// STARTUP (not build time) by a script in /docker-entrypoint.d/, generating
// its content from PIPELINE_BASE_URL / PIPELINE_API_KEY environment
// variables — see Dockerfile and docker/40-runtime-config.sh. That lets the
// same built image be pointed at a different server without rebuilding,
// matching how the pipeline-server container is configured via env vars.
window.PIPELINE_BASE_URL = window.PIPELINE_BASE_URL || "http://localhost:8000";
window.PIPELINE_API_KEY = window.PIPELINE_API_KEY || "";
