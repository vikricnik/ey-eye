# LLM Pipeline — Web Client (React + React Flow + Vite)

A visual builder and runner for the FastAPI + LangGraph DAG pipeline server:
draw the graph, configure every node, save it to the server, run it, and
watch each node light up as the server reports it running.

## Project structure

```
web/
├── index.html
├── package.json              # react, react-dom, @xyflow/react + @llm-pipeline/client
├── tsconfig.json             # "jsx": "react-jsx" — Vite's esbuild compiles TSX directly
└── src/
    ├── main.tsx              # React entry point
    ├── App.tsx               # loading, editing, live validation, save/import/export, runs
    ├── config.ts             # server URL / API key from public/runtime-config.js
    ├── style.css
    ├── editor/
    │   ├── PipelineCanvas.tsx  # React Flow canvas: drag nodes, draw edges, drop from palette
    │   ├── LlmNode.tsx         # a node card: model, temperature, live status
    │   ├── Inspector.tsx       # node / pipeline / edge / branch / loop settings
    │   ├── fields.tsx          # model picker, Ollama options form, inputs
    │   ├── PromptPreview.tsx   # what a node would receive, rendered by the server
    │   ├── Sidebar.tsx         # the Add tab: blank node, presets, legend
    │   ├── conversion.ts       # pipeline definition -> React Flow nodes/edges
    │   └── editorState.ts      # the edited document and validation state
    ├── run/
    │   ├── Chat.tsx            # the Chat tab (conversation picker, transcript) and the message box
    │   ├── MessagesView.tsx    # every node's received messages and replies, per run
    │   ├── MessageEntry.tsx
    │   └── runHistory.ts       # conversations kept in this browser (IndexedDB)
    ├── tests/TestsView.tsx     # test cases, test runs and model comparison
    └── ui/
        ├── Dialogs.tsx         # in-app confirm / prompt / form dialogs
        ├── SidePanel.tsx       # the one panel beside the canvas: tabs + message box
        ├── Splitter.tsx        # resizing the panel
        └── DisplaySettings.tsx # light/dark theme and text size
```

Every edit goes through `draftOps` in `@llm-pipeline/client` — the same
functions the CLI's edit commands use — and the server is the only
validator: the editor calls `POST /v1/drafts/validation` (debounced) and
shows what it says.

Types and the typed fetch client (`PipelineClient`, `RunResponse`, etc.) live in
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

Tests (the edit history, canvas layout and helpers) and the type check,
which covers the tests too:

```bash
npm test
npm run typecheck
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
# from the repo root — the image needs the shared packages/client workspace
docker build -f web/Dockerfile -t llm-pipeline-web .
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

**Layout**: the canvas fills the window, and **one panel** beside it holds
everything else as tabs — **Chat** (the conversation), **Settings** (the
selected node, or the pipeline when nothing is selected), **Add** (a blank
node or one from a preset), **Messages** (what every node received and
replied) and **Tests**. The message box sits at the bottom of the panel on
every tab, so you can send a message while editing. Selecting a node opens
its Settings. Drag the panel's edge to resize it (double-click resets; the
width is remembered); on a narrow screen the panel sits under the canvas.

**Display** ("Aa" in the header): **light or dark theme** — "System"
(the default) follows the operating system and switches with it — and
**text size** from 87.5% to 150%. Text also follows the browser's own
font-size setting. Canvas cards are a zoomable drawing in fixed
coordinates, so their text stays put; fitting the view zooms up to the
text size instead. Zoomed out, cards switch to a compact form — id, model
and a status mark (✓ done, ✕ failed, a pulsing dot while running) — whose
text stays at the text size on screen; zoom in for the details. Fitting
never zooms out further than that text can keep up with, so a very wide
pipeline extends past the edges (the minimap shows the rest). Both
settings are remembered in this browser.

**Building** (needs `PIPELINE_EDITING_ENABLED=true` on the server — without
it everything below is read-only and a banner says so):

- **New / Save / Save as / Import / Export / Delete** in the header. ⌘S /
  Ctrl+S saves — keeping the file's comments and layout. Export downloads
  the canonical YAML; Import loads a `.yaml` file as an unsaved draft.
  Delete moves the file to `pipelines/.deleted/` on the server
  (recoverable); the server's default pipeline can't be deleted.
- **Undo / redo** (↶ ↷, ⌘Z / ⇧⌘Z / Ctrl+Y): up to 100 steps; typing into
  one field is a single step. Undoing back to the saved state clears
  "unsaved". Inside a text field, ⌘Z undoes that field's typing instead.
- Names, confirmations and deletes use in-app dialogs with inline
  validation (no browser popups).
- **Add nodes** by dragging "LLM node" (or a preset)
  from the **Add** tab onto the canvas, or by clicking it — with a node
  selected, the new node is added *after* it (below it; further clicks place
  siblings side by side).
- **Duplicate a node** with **Duplicate** in its settings or ⌘D / Ctrl+D:
  the copy has the same settings and inputs and sits beside the original.
- **Draw edges** by dragging from a node's bottom handle to another node's
  top handle (that's `depends_on`). Select an edge or node and press
  Backspace/Delete to remove it.
- **Configure a node** in **Settings**: id (renaming rewrites every
  reference), model (picked from what `GET /v1/models` says is installed or
  allowlisted, with its max context, size and quantization), temperature, system prompt, prompt template (with insert
  buttons for `{{ message }}`, `{{ conversation }}` and each dependency's `{{ node.output }}`), all
  Ollama options (`num_ctx`, `num_predict`, `top_p`, `top_k`,
  `repeat_penalty`, `seed`, `stop`, `mirostat`, `keep_alive`, `format`, …),
  output-node flag, and its branch or loop.
- **Presets**: **Save as preset** (in a node's settings)
  keeps everything the node runs with — model, temperature, Ollama options,
  system prompt, prompt template, history and reasoning settings (a model or
  system prompt it inherits from the pipeline defaults is written out) —
  under a name and optional description. Presets are listed in the
  **Add** tab (hover for the details, filter when there are many): drag or
  click one to add it to any pipeline, pick one under **Start with** when
  creating a pipeline, or give an existing node its configuration from the
  node's **Presets** section. It's always a copy — changing a preset
  later doesn't change pipelines that use it. A saved prompt is fitted to
  where it lands: references to nodes the pipeline has become inputs, and
  when it names one node the pipeline lacks and the new node has one unused
  input (e.g. added below a selected node), the reference points at that
  input. ✕ removes a preset (recoverable on the server).
- **Live validation**: the header shows valid / invalid / warnings; an
  invalid node is outlined on the canvas and its Settings show the
  server's message. Save and Run are disabled while it's invalid. Warnings
  (a model a save would reject, or e.g. `num_ctx` above the model's maximum
  context) outline the node in amber but don't block anything.
- **Pipeline settings** (click empty canvas): description, output node(s),
  execution (timeout, retries, **parallel model calls**, **run time
  limit**), **conversation
  history** (turns kept, character budget, intro line, turn format, which
  nodes' outputs to remember, and an optional summarizer model + prompt),
  **defaults for all nodes** (model, temperature, Ollama options, system
  prompt, strip `<think>` reasoning), and a list of branches and loops.
- On a node: pick "pipeline default" as the model to inherit it, switch
  "sees the conversation history" off for nodes that should only see the
  new message, and override reasoning stripping. Prompt insert buttons
  include `{{ message }}`, `{{ conversation }}` and `{{ history }}`.
- Pipelines flow **top to bottom**: each dependency level is a row, and
  nodes that run in parallel sit side by side. Node positions are saved in
  the YAML (`layout`); **Auto-layout** re-arranges everything by dependency
  level (use it on pipelines saved before the layout became vertical).

**Running**:

- Runs always stream. Each node shows idle / **running** (pulsing) / done
  (with duration) / failed, driven by the server's `node_start` and
  `node_complete` events — so parallel nodes visibly run at the same time.
  Edges into a running node animate.
- **Live text**: a running node's card shows the newest words its model is
  writing, and the output node's answer types itself into the transcript as
  it's generated.
- **Messages** tab: a log of every run in the conversation — each node in
  the order it started, with the **system prompt and prompt it actually
  received** (its dependencies' outputs filled in) and the **reply** it
  produced, streaming live. Loop passes appear as separate entries
  ("iteration 2", …). Click a node's name to open its Settings.
- In a node's Settings, its own **Messages** sub-tab shows just that node's
  received messages and replies, newest run first. The sub-tab stays
  selected as you click from node to node.
- **Stop** (the Run button while a run is going, or Esc) ends it: the
  server stops the model calls, nodes that finished keep their output, and
  nothing is added to the conversation. Test runs have their own Stop.
- With unsaved changes, the button says **Save & run**: runs execute what's
  saved on the server, never an unsaved draft.
- Selecting a node after a run shows its last output in its Settings.
- **Tokens and context**: after a run, each node card shows how much of the
  model's context window its prompt used ("3.9k/4.1k ctx" — amber from 80%,
  red with ⚠ from 95%; hover for tokens in/out and tokens per second), and
  each Messages entry lists the same. When the prompt filled the window — or
  was simply longer than it could hold — Ollama has **cut off the start of
  the prompt** (silently, reporting only the tokens it kept), and the card
  and entry say so.
- **Prompt preview** (under a node's prompt template, while editing): what
  the node would receive, rendered by the server exactly as a run renders
  it — for the latest message with that run's outputs (so it matches a
  re-run), or with placeholders before the first run. Follows your edits.
- **Re-run from here** (a node's settings, or a node in the latest run's
  Messages): runs the latest message again from that node — the nodes before
  it reuse their outputs ("reused" on the card and in the log), so tuning a
  late prompt doesn't re-run everything before it. The new answer replaces
  the latest one in the conversation.
- **Conversations are kept** in this browser (IndexedDB), saved after every
  run: reloading, or coming back to a pipeline, continues its latest
  conversation. The picker at the top of **Chat** lists a pipeline's past
  ones (the last 30) to reopen; "+ new" starts over and ✕ deletes one.
- **"show every node's output"** (in Chat) lists every node's output in the
  transcript.

**Tests** (a tab in the panel): the pipeline's test cases — a message
each, and what the answer must satisfy: contains / doesn't contain
(case-insensitive), a `check` condition like a branch's, or a requirement a
**judge model** grades PASS/FAIL with its reason. Cases are saved with the
pipeline. "Run all cases" (or one) runs the draft as it is — no save needed —
and fills a results grid case by case, with time and tokens; click a cell
for the answer and each expectation. **Compare models** runs every case
again with up to three other models for one node, side by side with the
pipeline as it is, with pass rates and totals per column. "+ from the last
message" turns the latest message into a case. Running tests needs editing
enabled on the server.

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

Every server error — 400/401/403/404/409/412/422/428/429/502, and even a genuine
unhandled 500 — comes back as one consistent structured object. When a
request fails, the transcript shows the error message plus a small
"reference id" line (the server's `request_id`, same value as its logged
`X-Request-ID`) — useful to include if reporting an issue, since it's
searchable directly in server logs.

## Conversation history

The client sends the earlier turns (with any remembered node outputs) on
every request; how many are kept, the character budget and whether older
turns are summarized are per-pipeline settings (click empty canvas →
Conversation history). "+ new" in Chat starts a new conversation;
switching pipelines continues that pipeline's latest one.
