# LLM Pipeline Monorepo

A **YAML-defined DAG orchestration system** for LLM pipelines: any number of
named nodes, each backed by any provider (Ollama, OpenAI, Anthropic, Gemini),
wired together by simple `depends_on` edges. Parallel execution, sequential
ordering, and cross-node collaboration all fall directly out of the DAG
shape — there's no separate "mode" to configure.

```
llm-pipeline-monorepo/
├── llm_pipeline/   Python — FastAPI + LangGraph DAG orchestration server
│   └── pipelines/    YAML pipeline definitions (consensus-qa, code-review, simple-local)
├── cli/             TypeScript — keyboard-driven terminal client
└── web/             TypeScript + Vite — browser client
```

## Architecture at a glance

```
YAML file (nodes + depends_on)
            |
            v
  pipeline_config.py    validates: no cycles, no dangling deps,
                          no unresolved template refs, valid output_node
            |
            v
  dag_builder.py          one graph node per YAML node, one edge per
                            depends_on entry — nothing else
            |
            v
  compiled LangGraph       parallel siblings run concurrently (no edge
                            between them); a join waits for ALL its
                            dependencies; ordering/"collaboration" is just
                            whether an edge exists and whether a template
                            references it — no special-case handling anywhere
```

### Example: A → (B, C) → D

```yaml
nodes:
  - id: A
    depends_on: []
    ...
  - id: B
    depends_on: [A]      # B and C have no edge between them
    ...                    #   -> they run in PARALLEL once A finishes
  - id: C
    depends_on: [A]
    ...
  - id: D
    depends_on: [B, C]    # D waits for BOTH B and C — automatic join
    ...
output_node: D
```

Want B to run before C instead? Add `depends_on: [A, B]` to C — that's the
entire difference between parallel and sequential. Want C's prompt to build on
B's answer? Reference `{B.output}` in C's `prompt_template` while depending on
it — that's the entire difference between independent and collaborative.
Nothing else changes.

## Project structure

```
llm-pipeline-monorepo/
├── package.json                npm workspace root (links cli/, web/, packages/client/)
├── packages/client/              @llm-pipeline/client — shared API types + typed
│                                  fetch client, single source of truth for the
│                                  request/response contract both clients depend on
├── cli/                           keyboard-driven terminal client
├── web/                            browser client
└── llm_pipeline/                    Python package (Poetry)
    ├── providers/                    LLMProvider Protocol + one adapter module per
    │                                 backend (ollama.py, openai.py, anthropic.py,
    │                                 gemini.py, copilot.py) + registry.py (factory)
    │                                 + resilience.py (timeout/retry/circuit breaker)
    ├── dag_builder/                    graph.py (assembly) + node_types.py (the
    │                                   node-type registry — the extension point for
    │                                   future retrieval/tool/human_approval node
    │                                   types) + branches.py + loops.py + templating.py
    ├── pipeline_config/                  schema.py (pure Pydantic models) +
    │                                     validation.py (standalone DAG-level checks,
    │                                     independently testable) + loader.py
    ├── routers/                            health.py + ask.py (FastAPI route handlers)
    ├── api_schemas.py                        the public HTTP contract (request/response
    │                                         models — anything that crosses the wire)
    ├── state.py                                internal LangGraph state — free to change
    │                                           without being an API-breaking change
    ├── pipeline_loader.py                        PipelineCache — owns the compiled-graph
    │                                             cache AND its own CircuitBreaker
    │                                             instance, injected via app.state
    │                                             rather than bare module globals
    ├── error_handling.py                            the 3 exception handlers + shared
    │                                                 ErrorResponse builder
    └── main.py                                        composition root only — app
                                                          creation, middleware, router
                                                          registration; no route logic
```

A few design decisions worth calling out:

- **The provider/dag_builder/pipeline_config splits use `__init__.py` re-exports**,
  so `from llm_pipeline.providers import ModelSpec, get_provider` (etc.) keeps
  working exactly as before — the split is an internal reorganization, not a
  breaking change to how these are imported elsewhere.
- **`PipelineCache` replaced bare module-level globals** (`_pipeline_cache` dict,
  a process-wide `CircuitBreaker`) with one object stored on `app.state` and
  injected via `Depends(get_pipeline_cache)`. This is the actual architectural
  fix for a real bug hit earlier in development — a circuit breaker shared
  globally across tests let one test's deliberate failures leak into an
  unrelated test using the same model identity. With DI, each `PipelineCache`
  (one per app instance) has fully independent state; nothing to leak.
- **`pipeline_config/schema.py` and `validation.py` have a deliberate one-way
  dependency**, made safe via a `TYPE_CHECKING`-guarded import in `validation.py`
  and a deferred (function-body) import in `schema.py` — this lets validation
  logic live as standalone, independently-testable functions instead of
  sprawling `@model_validator` methods, without a real circular import.
- **`api_schemas.py` vs. `state.py`** — the public API contract vs. internal
  LangGraph plumbing are now separate files specifically so a change to
  `PipelineState`'s internal shape is never confused with a breaking change to
  the HTTP API.

## Quickstart

### 1. Start the pipeline server

```bash
cd llm_pipeline
poetry install
cp .env.example .env
ollama pull llama3.2:3b llama3 qwen3-coder:30b
poetry run uvicorn llm_pipeline.main:app --reload --port 8000
```

```bash
curl http://localhost:8000/health
```

### 2. Install client dependencies (once, from the repo root)

```bash
npm install
```

This is an **npm workspace** — `cli/`, `web/`, and `packages/client/` (the
shared API types + typed fetch client both clients depend on) are linked
together by this one install. Running `npm install` separately inside
`cli/` or `web/` won't correctly link `@llm-pipeline/client` — always
install from the repo root.

### 3. Use the CLI

```bash
cd cli
npm start
```

```
(simple-local) › /pipelines
Available pipelines (3)
  simple-local — Single-node, all-Ollama pipeline for quick local testing
  consensus-qa — Multi-provider consensus for factual Q&A
  code-review-pipeline — Plan, then implement + test in parallel, then review and merge

(simple-local) › /use consensus-qa
switched to pipeline "consensus-qa" — conversation history cleared

(consensus-qa) › What year did the Berlin Wall fall?
```

### 4. Or use the web client

```bash
cd web
npm run dev
```

Open the printed URL, pick a pipeline from the dropdown in the header, and
start typing.

Full details for each component: [`llm_pipeline/README.md`](llm_pipeline/README.md),
[`cli/README.md`](cli/README.md), [`web/README.md`](web/README.md).

## Two example pipelines, two different DAG shapes

### `consensus-qa` — multi-model consensus
Three models (local Ollama + GPT-4o + Claude) independently answer the same
question in parallel (three roots, no edges between them), then a fourth node
reconciles them into one authoritative answer. **Use case**: reducing
hallucination risk on factual Q&A by cross-checking across independent models
— if they disagree, the reconciler node has to say so explicitly rather than
silently pick one.

### `code-review-pipeline` — task decomposition
`plan` runs first; `implement` and `write_tests` both depend only on `plan`
(parallel middle layer, since there's no edge between them); `review` depends
on both and combines them. **Use case**: splitting a task into genuinely
independent sub-steps (an implementation and its tests don't need each
other's output, just a shared plan) that only need to converge at the very
end.

Same schema, same builder, structurally different shapes — validated by
building both against the identical DAG mechanism rather than adding
per-use-case special handling.

## Phase 2: branches and loops

Two additional mechanisms layer conditional control flow on top of the base
DAG, for cases a plain DAG can't express:

### `support-router.yaml` — conditional branching
`classify` picks exactly ONE of `refund_flow` / `tech_support_flow` /
`general_flow` — the other two never execute for that request. Routes are
evaluated through a small **sandboxed expression language** (never `eval()`
— see `llm_pipeline/safe_eval.py`), validated for safety and syntax at YAML
load time.

### `iterative-refinement.yaml` — bounded revision loop
`generate` → `critique` → loop back to `generate` up to 3 times until
`critique` says APPROVE, then exit. Bounded by `max_iterations` so it can
never run away; `on_max_iterations: proceed | fail` decides what happens if
it never converges.

Both compile to LangGraph conditional edges under the hood. Full schema
reference: [`llm_pipeline/README.md`](llm_pipeline/README.md#branches--conditional-routing).

## Where this fits in production (and where it doesn't)

**Good fit:**
- Multi-model consensus for anything where a wrong answer is costly
- Task decomposition where sub-steps are genuinely independent enough to
  parallelize (code + tests, draft + fact-check, extract + classify)
- Cost/latency tiering — a cheap local model for a first-pass node, an
  expensive frontier model only for the step that actually needs it
- Provider resilience/evaluation — running the same prompt through two
  providers to compare quality/cost/latency

**Not a good fit:**
- Simple single-turn Q&A where one model call suffices — the orchestration
  overhead (multiple network hops, DAG validation) adds cost/latency for no
  quality gain
- Low-latency conversational chat — each node is a real network round trip;
  fine for report generation, not for sub-second responses
- Workflows needing the model to decide its own next step dynamically — this
  is a **static** DAG per YAML file; genuine runtime branching needs
  `add_conditional_edges` layered on top (see "Deferred" below)

## Writing your own pipeline

See [`llm_pipeline/README.md`](llm_pipeline/README.md#writing-a-pipeline-yaml)
for the full schema reference. The short version: define `nodes`, give each
one an `id`, a `model` (provider + model + temperature), a `prompt_template`,
and a `depends_on` list; pick which node is `output_node`. Validation catches
cycles, dangling references, and unresolved template placeholders at load
time, before the pipeline ever runs.

## Conversation history

Both clients maintain session-local history and send it with every request;
the server folds up to `execution.max_history_turns` (set per-pipeline in its
YAML) prior turns into context. This is **raw replay** — simple, but token
cost grows with conversation length. Switching pipelines (CLI's `/use`, the
web client's dropdown) clears history automatically, since a different DAG
shape likely has different context semantics. See the pipeline README for
notes on summarization as a future improvement.

## Stateless pipeline selection — why there's no "activate" endpoint

Every `/ask` call specifies `pipeline_name` explicitly; the server has no
server-side "currently active pipeline" to mutate. This was a deliberate
choice over a stateful `/pipelines/{name}/activate` design: a global "active"
variable would live independently in each worker process under
`uvicorn --workers N`, so activating a pipeline would only affect whichever
worker received that specific request — a real consistency bug the moment you
scale beyond one process. Stateless per-request selection has no such shared
state to disagree about.

## Deliberately deferred

**Loops and forward branching are now implemented** (see "Phase 2" above) —
what's left, designed at a sketch level but intentionally not built yet, see
[`llm_pipeline/README.md`](llm_pipeline/README.md#deliberately-deferred-not-in-this-version)
for the full reasoning on each:

- **Dynamic map-reduce fan-out** (run a node once per item in a runtime list)
- **Non-LLM node types** (retrieval, tool execution, human-approval gates —
  the `type` field exists now so adding these later isn't a breaking change)
- **Streaming** `/ask` responses (currently one JSON blob at the end; both
  clients' progress indicators are best-effort client-side pacing, not real
  per-node events)

## Deployment notes

- **Auth**: set `API_KEYS` (comma-separated) before exposing the server
  beyond localhost — it's **empty by default** (no authentication), with a
  startup warning logged when that's the case. Both clients need the
  matching key set (`PIPELINE_API_KEY` for the CLI, `window.PIPELINE_API_KEY`
  for the web client) once this is enabled.
- **Pipeline server**: behind a process manager or containerized (see
  `llm_pipeline/Dockerfile` and root `docker-compose.yml`); drop `--reload`;
  set `CORS_ALLOWED_ORIGINS` to your actual client origin(s). Ship
  `pipelines/*.yaml` as version-controlled, code-reviewed files baked into
  the deployment — there's no upload/mutation endpoint by design.
- **CI**: `.github/workflows/ci.yml` validates every `pipelines/*.yaml` file,
  runs `mypy --strict` + `pytest`, and type-checks both TypeScript clients on
  every push/PR.
- **Ollama**: `OLLAMA_BASE_URL` for remote instances; match
  `OLLAMA_MAX_LOADED_MODELS` (set in Ollama's own environment) to how many
  Ollama-backed nodes might run concurrently across your pipelines.
- **Cloud providers**: set `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`/`GOOGLE_API_KEY`
  in the server's environment if any pipeline YAML references those providers.
- **Rate limiting**: `RATE_LIMIT_REQUESTS_PER_MINUTE` is enforced per
  process — running multiple server instances behind a load balancer means
  each enforces its own limit independently (see `rate_limit.py`'s docstring).
- **CLI**: `npm run build && node dist/index.js`.
- **Web**: `npm run build` → static files in `web/dist/`, served by any static
  host, with `window.PIPELINE_BASE_URL` pointed at your deployed server.

### Quick start with Docker Compose

```bash
docker compose up
```
Runs Ollama + the pipeline server + the web client together. Open
`http://localhost:8080` for the web UI. Set `API_KEYS` and any cloud
provider keys as environment variables in `docker-compose.yml` before
exposing this beyond your local machine.

The CLI isn't part of this stack — it's an interactive terminal tool, a
genuinely weaker fit for Docker than the web client's static build (see
`cli/README.md`'s Docker section for the full reasoning and how to run it
in a container anyway if you have a specific reason to). Plain
`npm install && npm start` against the running compose stack
(`PIPELINE_BASE_URL=http://localhost:8000 npm start`, from `cli/`) is the
normal way to use it alongside `docker compose up`.

## License

Use this however you like — no license restrictions imposed by this scaffold.
