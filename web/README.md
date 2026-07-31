# LLM Pipeline — Web Client (TypeScript + Vite)

A typed, modular web client for the FastAPI + LangGraph pipeline. HTML, CSS, and
TypeScript are kept in separate files; Vite handles bundling and dev-server hot reload.

## Project structure

```
web/
├── index.html          # structure only — no inline styles or scripts
├── package.json
├── tsconfig.json
└── src/
    ├── style.css        # all styling
    ├── types.ts         # shared types matching the FastAPI response schema
    ├── apiClient.ts     # typed fetch wrapper for /health and /ask, sends conversation history
    ├── relayAnimator.ts # pipeline-stage indicator animation
    ├── render.ts         # DOM rendering (transcript entries, candidates, errors)
    └── main.ts           # entry point — wires everything together, conversation memory
```

## Setup

```bash
npm install
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

## Pointing at a different pipeline server

By default the client talks to `http://localhost:8000`. Override it by setting
`window.PIPELINE_BASE_URL` before the app loads — add this to `index.html` just above
the `<script type="module" src="/src/main.ts">` line:

```html
<script>window.PIPELINE_BASE_URL = "http://localhost:9000";</script>
```

## ⚠️ CORS — required server-side change

This client runs in a browser, so the FastAPI server needs CORS enabled. The server
in this monorepo already has it configured via `CORS_ALLOWED_ORIGINS` in `.env` — see
the root README and `llm_pipeline/.env.example`.

## Features

- Type a prompt, press **Enter** to send (**Shift+Enter** for a newline)
- Live health indicator in the header (polls `/health` every 15s)
- A "relay track" animates through Route → Generate → Validate → Judge while a request
  is in flight — client-side pacing only, since the API returns one JSON response
  rather than streamed per-stage events; it snaps to complete the moment the real
  response lands
- **Conversation memory** — prior turns in the session are sent as context with each
  request, so follow-ups like "make it faster" work without repeating yourself.
  Click **"reset conversation"** to clear history and start fresh.
- **"show all candidates"** checkbox reveals every generator's answer, validation
  status, and individual validator votes
- Every response shows which model handled routing (`router`), which generated the
  winning answer (`winner`), and which judged the candidates (`judge`) — formatted as
  `provider:model`, e.g. `ollama:qwen3-coder:30b`

## Known limitation: history isn't summarized

History is sent as raw prior turns, capped server-side by `LLM_MAX_HISTORY_TURNS`.
Long conversations mean growing token cost per request — use "reset conversation" to
clear it, or see the server README's notes on summarization as a future improvement.
