# LLM Pipeline — Web Client (TypeScript + Vite)

A typed, modular web client for the FastAPI + LangGraph DAG pipeline server.
HTML, CSS, and TypeScript are kept in separate files; Vite handles bundling
and dev-server hot reload.

## Project structure

```
web/
├── index.html          # structure only — no inline styles or scripts
├── package.json          # depends on @llm-pipeline/client (../packages/client)
├── tsconfig.json
└── src/
    ├── style.css          # all styling
    ├── relayAnimator.ts     # builds & animates stage indicators dynamically per pipeline
    ├── render.ts             # DOM rendering (transcript entries, node outputs, errors)
    └── main.ts                # entry point — pipeline picker, conversation memory, event wiring
```

Types and the typed fetch client (`PipelineClient`, `AskResponse`, etc.) live in
the shared `@llm-pipeline/client` package (`../packages/client`) — the CLI
depends on the exact same package, so the request/response contract only has
one source of truth. See the root README's "Project structure" section.

## Setup

Install from the **repo root** (this is an npm workspace — `@llm-pipeline/client`
won't link correctly if you `npm install` from inside `web/` directly):

```bash
cd ..            # repo root
npm install
cd web
```

## Run (dev server with hot reload)

```bash
npm run dev
```

Vite prints a local URL (typically `http://localhost:5173`) — open it in a browser.

## Build for production

```bash
npm run build
npm run preview   # preview the production build locally
```

## Configuring which pipeline server to talk to

By default the client talks to `http://localhost:8000` with no API key. Two
ways to override this, depending on how you're running the app:

**Plain static hosting (no Docker)** — edit `public/runtime-config.js`
directly before building, or edit the built `dist/runtime-config.js` after:
```js
window.PIPELINE_BASE_URL = "http://localhost:9000";
window.PIPELINE_API_KEY = "your-key"; // only if the server has API_KEYS set
```

**Docker** — set environment variables at container *startup*; see the
Docker section below. This works without rebuilding the image, since the
config file is regenerated fresh each time the container starts.

⚠️ Anything set here is visible to anyone with browser devtools — this is a
"shared team secret" pattern suitable for an internal tool already behind
its own access control (VPN, internal network, etc.), **not** a real
security boundary for a public-facing deployment.

## Docker

```bash
docker build -t llm-pipeline-web .
docker run -p 8080:80 \
  -e PIPELINE_BASE_URL=http://host.docker.internal:8000 \
  llm-pipeline-web
```

Open `http://localhost:8080`.

This is a genuinely good fit for Docker, unlike the CLI — after `npm run
build` this is just static files, so the image is a standard two-stage
build: Node compiles the bundle, then an `nginx:alpine` image serves it.

**How runtime configuration works**: `PIPELINE_BASE_URL`/`PIPELINE_API_KEY`
are read at **container startup**, not baked in at build time. nginx's
official image automatically runs every script in `/docker-entrypoint.d/`
before it starts serving — `docker/40-runtime-config.sh` uses this to
(re)write `runtime-config.js` from the current environment variables each
time the container starts. This means the same built image can point at a
different server (or use a different key) in different environments without
rebuilding — just change the env vars passed to `docker run`/`docker compose`.

⚠️ **`PIPELINE_BASE_URL` must be reachable from the browser**, not just from
inside Docker's network — the web client's JS runs on the user's machine,
not inside this container. If the pipeline server is a sibling container
(e.g. via `docker compose`), use its *published host port*
(`http://localhost:8000`), not its internal service name
(`http://pipeline-server:8000`) — the latter only resolves between
containers, not from a browser on the host. See root `docker-compose.yml`
for a worked example with this exact comment in place.

Via `docker compose` (from the repo root, brings up Ollama + the pipeline
server + this web client together):
```bash
docker compose up
```
Then open `http://localhost:8080`.

## ⚠️ CORS — required server-side change

This client runs in a browser, so the FastAPI server needs CORS enabled —
already configured server-side via `CORS_ALLOWED_ORIGINS` in `.env`.

## Features

- **Pipeline picker** in the header — populated from `GET /pipelines` on load,
  defaults to the server's `default_pipeline_name`. Switching pipelines clears
  conversation history automatically, since a different DAG shape likely has
  different context semantics.
- Type a prompt, press **Enter** to send (**Shift+Enter** for a newline)
- Live health indicator in the header (self-scheduling async poll every 15s —
  not `setInterval`, so a slow health check can't cause overlapping requests)
- A **dynamic relay track** shows the active pipeline's actual node list
  (fetched from `GET /pipelines/{name}`) and animates through them while a
  request is in flight. With **"stream progress"** on (see below), this
  reflects REAL node completions as they happen (`relay.markComplete()`,
  driven by actual `node_complete` SSE events) rather than simulated
  pacing; with it off, it's client-side pacing only — the non-streaming API
  returns a single JSON response with no per-node timing — so once the last
  node is reached, its indicator keeps pulsing indefinitely (rather than
  freezing) until the real response arrives, however long that takes.
- **"stream progress"** checkbox (off by default) switches to `POST
  /ask/stream`, showing each node as it actually completes instead of one
  spinner until the whole pipeline finishes. This is **node-level**
  progress, not token-level — each relay stage completes when that node
  finishes, not as the model streams individual words. See
  `llm_pipeline/README.md`'s `POST /ask/stream` section for why (token-level
  streaming would mean every provider adapter implementing it individually;
  node-level works uniformly across all of them).
- **Conversation memory** — prior turns in the session are sent as context.
  Click **"reset conversation"** to clear it manually.
- **"show all node outputs"** checkbox reveals every node's output and which
  model produced it, alongside its execution time. Combines with streaming —
  with both on, each node's output appears as soon as that node completes.
- Every response shows `pipeline_name`, `output_node`, how long the whole run
  took, and (for pipelines using loops, like `iterative-refinement.yaml`) how
  many times each loop looped back before exiting.
- Pipelines using **branches** (like `support-router.yaml`) only ever show the
  node(s) that actually ran for that request — the routes that weren't taken
  never appear, since they never executed.

## Response fields

This client renders the DAG-based response shape:

```json
{
  "pipeline_name": "consensus-qa",
  "output_node": "reconcile",
  "final_answer": "...",
  "node_outputs": {
    "answer_local": { "node_id": "answer_local", "model_name": "ollama:qwen3-coder:30b", "output": "...", "duration_ms": 1820 },
    "answer_b": { "node_id": "answer_b", "model_name": "ollama:llama3", "output": "...", "duration_ms": 2140 },
    "reconcile": { "node_id": "reconcile", "model_name": "ollama:llama3", "output": "...", "duration_ms": 4230 }
  },
  "loop_iterations": {}
}
```

`loop_iterations` maps each loop id to how many times it looped back — `{}`
for pipelines with no loops, populated for pipelines like
`iterative-refinement.yaml`.

This replaces the old fixed `category`/`router_model`/`winner_model`/`judge_model`/
`candidates`/`votes` shape from the pre-DAG design — there's no fixed set of
pipeline tiers anymore, since a pipeline's shape is whatever its YAML defines.

## Error handling

Every server error — 400/401/404/422/429/502/503, and even a genuine
unhandled 500 — comes back as one consistent structured object. When a
request fails, the transcript shows the error message plus a small
"reference id" line (the server's `exceptionUID`, same value as its logged
`X-Request-ID`) — useful to include if reporting an issue, since it's
searchable directly in server logs.

## Known limitation: history isn't summarized

History is sent as raw prior turns, capped server-side by the active
pipeline's `execution.max_history_turns` (set per-pipeline in its YAML). Long
conversations mean growing token cost per request — use "reset conversation"
or switch pipelines to clear it.
