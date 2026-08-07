# llm_pipeline — YAML-defined DAG orchestration over any LLM provider

A pipeline is a **DAG defined in YAML**: named nodes, each declaring which other
nodes it `depends_on`, templated with Jinja2. Two additional, deliberately
separate mechanisms — `branches` and `loops` — layer conditional control flow
on top when a plain DAG isn't enough.

- Two nodes with no edge between them run **in parallel**, automatically,
  because LangGraph schedules any node the instant all of its dependencies
  are satisfied.
- An edge between two nodes forces **order**.
- A node referencing `{{ other_node.output }}` in its prompt while declaring
  that node in `depends_on` is what **"collaboration"** means here — not a
  separate flag, just a template referencing a dependency's result.
- A node with multiple `depends_on` entries doesn't run until **all** of them
  finish — a join, also automatic.
- **`branches`**: a node's output picks exactly ONE of several downstream
  paths — the others never execute for that request.
- **`loops`**: a bounded generate → critique → revise cycle, up to
  `max_iterations` times.

## Architecture

```
providers/                LLMProvider Protocol + one adapter module per backend
├── base.py                 ProviderType, ModelSpec, LLMProvider Protocol, ProviderError
├── ollama.py / openai.py / anthropic.py / gemini.py / copilot.py
│                            one file per backend — adding a provider means
│                            writing one new file + one registry.py branch,
│                            never touching the others
├── registry.py               get_provider() factory + cache
└── resilience.py              CircuitBreaker, generate_with_timeout,
                                generate_with_retry — genuinely provider-agnostic,
                                would apply identically to a future non-LLM node type

dag_builder/               Turns a validated PipelineDefinition into a compiled LangGraph
├── graph.py                 assembly: base depends_on edges + branch/loop wiring
├── node_types.py              the node-type registry (NODE_BUILDERS dict) — the
│                              extension point for future retrieval/tool/
│                              human_approval node types; today only llm_call
├── branches.py                  conditional routing (a node's output picks ONE path)
├── loops.py                      bounded generate/critique/revise cycles
└── templating.py                  Jinja2 prompt rendering

pipeline_config/            YAML schema + validation
├── schema.py                 pure Pydantic model definitions
├── validation.py               DAG-level checks (cycles, branch/loop consistency,
│                                template references) as standalone functions —
│                                independently testable, not sprawling
│                                @model_validator methods
└── loader.py                     reads/lists pipeline YAML files from disk

routers/                    FastAPI route handlers
├── health.py                 GET /health, /pipelines, /pipelines/{name}
└── ask.py                      POST /ask + prompt/history validation

safe_eval.py                Sandboxed expression language for `when`/`exit_when` —
                             never eval(), a small whitelisted AST subset
api_schemas.py                The public HTTP contract — every request/response
                              model that crosses the wire
state.py                       Internal LangGraph state (PipelineState, NodeResult) —
                                free to change without being an API-breaking change
pipeline_loader.py               PipelineCache — owns the compiled-graph cache AND
                                  its own CircuitBreaker instance, injected via
                                  app.state (Depends(get_pipeline_cache)) rather
                                  than bare module-level globals
error_handling.py                  The 3 exception handlers + shared ErrorResponse
                                    builder + OpenAPI response documentation map
history.py                          Conversation-context folding
settings.py                          pipelines_dir, default_pipeline_name, auth,
                                      rate limiting, Ollama/CORS config
errors.py                             PipelineExecutionError, PipelineNotFoundError
main.py                                Composition root ONLY — app creation,
                                        middleware, router registration. No route
                                        logic or business logic lives here directly.
```

### Why dependency injection for the pipeline cache?

`PipelineCache` (in `pipeline_loader.py`) replaced what used to be a bare
module-level dict plus a bare module-level `CircuitBreaker` singleton. This
isn't just style — it's the fix for a real bug found during development: a
circuit breaker shared as a process-wide global let one test's deliberate
provider failures leak into an unrelated test that happened to use the same
model identity (`ollama:test-model`), causing it to fail with "circuit open"
before ever reaching its own (working) mocked provider.

Bundling the compiled-graph cache and its circuit breaker into one object,
constructed fresh in `main.py`'s `lifespan` function and stored on
`app.state`, means every app instance (production, or a test's own
`TestClient`) gets fully independent state automatically — there's no
global left to leak through, and no autouse fixture needed to reset it
between test runs (see `tests/test_error_responses.py`, which uses
`with TestClient(app) as client:` specifically because that re-runs
`lifespan` and constructs a fresh `PipelineCache` on every test).

### Why stateless per-request pipeline *selection*?

Every `/ask` call includes `pipeline_name` explicitly, and the server loads/caches
compiled graphs by name rather than mutating a global "currently active"
pipeline. This matters once you run more than one worker process
(`uvicorn --workers N`): a global "active pipeline" would live independently
in each worker's memory, so an "activate" call would only affect whichever
worker happened to receive it. Stateless selection sidesteps this entirely —
distinct from the `PipelineCache` DI discussion above, which is about *how*
state is scoped, not *whether* there's a server-side "active" pipeline concept
at all (there isn't, by design).

## Writing a pipeline YAML — the base DAG

```yaml
name: my-pipeline
description: What this pipeline does
version: 1

execution:
  model_timeout_seconds: 60   # hard timeout per node's model call
  max_history_turns: 6         # prior conversation turns folded into {{ input }}

nodes:
  - id: analyze
    depends_on: []              # no dependencies = a root node, runs first
    model: { provider: ollama, model: llama3.2:3b, temperature: 0.0 }
    prompt_template: "Analyze this request: {{ input }}"

  - id: draft
    depends_on: [analyze]        # runs after `analyze` completes
    model: { provider: ollama, model: llama3, temperature: 0.3 }
    # Any node can use a different provider — e.g.
    # { provider: openai, model: gpt-4o, temperature: 0.3 } — see
    # pipelines/consensus-qa.yaml for a worked example with commented-out
    # cloud alternatives. Requires the matching `uv sync --extra`
    # and API key; see "Requirements" below.
    prompt_template: |
      Analysis: {{ analyze.output }}
      Original request: {{ input }}
      Write a draft response.

output_node: draft   # which node's output becomes final_answer
```

Templates are **Jinja2** — you get `{% if %}`/`{% for %}` etc., not just plain
substitution. This matters for loops (see below): a loop's `back_to` target
references a node that genuinely hasn't run yet on the first iteration, so its
template needs `{% if x is defined %}` around that reference.

## Branches — conditional routing

```yaml
branches:
  - id: route_by_intent
    from: classify
    routes:
      - when: '"REFUND" in output'
        to: refund_flow
      - when: '"TECHNICAL" in output'
        to: tech_support_flow
      - default: true
        to: general_flow

# Only ONE of these three actually runs per request — output_node as a LIST
# lets the server pick whichever candidate is actually present in the result.
output_node: [refund_flow, tech_support_flow, general_flow]
```

- `from` is the node whose output decides the route. `when` conditions are
  evaluated **in order**; the first match wins. Exactly one route must have
  `default: true` as the fallback.
- `when` conditions run through `safe_eval.py` — a tiny, sandboxed subset of
  Python (`output.startswith(...)`, `output.contains(...)`, `"X" in output`,
  `and`/`or`/`not`), **never** `eval()`. Syntax is validated at YAML load time,
  not the first time a request happens to hit that branch.
- A branch's route targets (`refund_flow`, etc.) have `depends_on: []` but are
  **not** automatic entry points — they only run when actually routed to.
  `output_node` must be a **list** of candidates once a branch means only one
  of several possible "final" nodes runs per request; the server picks
  whichever one actually has a result.

## Loops — bounded revision cycles

```yaml
nodes:
  - id: generate
    depends_on: []
    model: { provider: ollama, model: llama3, temperature: 0.4 }
    prompt_template: |
      {{ input }}
      {% if critique is defined %}
      Revise based on this critique: {{ critique.output }}
      {% endif %}

  - id: critique
    depends_on: [generate]
    model: { provider: ollama, model: llama3.2:3b, temperature: 0.0 }
    prompt_template: |
      Review this answer: {{ generate.output }}
      Reply "APPROVE" if good, or "REVISE: <feedback>" otherwise.

loops:
  - id: revise_until_approved
    from: critique
    back_to: generate
    exit_to: END          # or another node id
    exit_when: 'output.startswith("APPROVE")'
    max_iterations: 3
    on_max_iterations: proceed   # proceed | fail

output_node: generate   # NOT critique — critique's text is just APPROVE/REVISE;
                         # the actual answer lives in generate's latest output
```

- `from` is the node whose output decides whether to loop or exit. `back_to`
  is where execution resumes if looping; `exit_to` is where it goes once
  `exit_when` matches (or `max_iterations` is hit) — a real node id, or the
  literal string `"END"` to end the graph directly.
- `max_iterations` caps how many times the loop can go back;
  `on_max_iterations: proceed` completes anyway using the last attempt,
  `fail` raises `PipelineExecutionError` instead.
- Since `node_outputs` only ever holds the **latest** result per node id,
  `generate`'s entry is automatically its most-revised version by the time the
  loop exits — regardless of how many iterations happened.
- The `{% if critique is defined %}` guard is required, not optional: on the
  very first pass, `critique` genuinely hasn't run yet, and Jinja raises
  immediately on an unguarded `{{ critique.output }}` reference to an
  undefined variable — this is intentional (see "Validation" below).

## Validation, at load time (`pipeline_config/validation.py`)

- **No cycles in `depends_on`** — this check applies to the base DAG only.
  Loops are a deliberately *separate* mechanism and are expected to introduce
  real cycles in the compiled graph; that's the entire point of them.
- **No dangling dependencies / branch or loop targets** — every reference
  must point to a real node id.
- **Exactly one default route per branch**; every non-default route must set
  `when`.
- **`when`/`exit_when` expressions must parse under the safe evaluator** —
  a typo'd or unsafe expression fails at load time, not at request time.
- **A node's outgoing edges can't be split between plain and conditional** —
  once a node is a branch/loop `from_`, ALL of its outgoing routing must go
  through that one construct (LangGraph doesn't support mixing a plain edge
  and a conditional edge from the same source). If another node's
  `depends_on` names that source without being a declared destination of the
  branch/loop, that's a load-time error (the edge would otherwise be silently
  dropped by the builder).
- **Template references, checked via Jinja's AST** (`jinja2.meta.find_undeclared_variables`,
  not naive string search) — every `{{ node_id.output }}` (or bare `node_id`
  used in an `is defined` test) must correspond to either a declared
  `depends_on` entry, or the `from_` node of a loop whose `back_to` is this
  node (the one case where a reference is legitimate without `depends_on`,
  since the loop mechanism — not `depends_on` — guarantees ordering).
- **At least one true entry point** — after excluding branch route targets
  (which must never run unconditionally at the start), some node with no
  dependencies must remain.

Run this validation yourself any time with:
```bash
uv run python -c "from pathlib import Path; from llm_pipeline.pipeline_config import load_pipeline_definition; load_pipeline_definition(Path('pipelines/your-file.yaml'))"
```
(Worth wiring into CI as a step that validates every file in `pipelines/*.yaml`
on every push.)

## Node types

Every node has a `type` field (defaults to `llm_call`, the only type
implemented today) — forward-compatible for `retrieval`/`tool`/`human_approval`
node types later without changing the schema shape of every existing pipeline.

## Example pipelines shipped in `pipelines/`

### `simple-local.yaml`
A single node, all-Ollama. No cloud API keys needed.

### `consensus-qa.yaml` — multi-provider consensus
Three independent models (Ollama, GPT-4o, Claude) answer in parallel, then a
fourth node reconciles them. Use case: reducing hallucination risk by
cross-checking across providers.

### `code-review-pipeline.yaml` — task decomposition
`plan` runs first; `implement` and `write_tests` both depend only on `plan`
(parallel, no edge between them); `review` depends on both. Use case:
splitting a task into genuinely independent sub-steps.

### `iterative-refinement.yaml` — bounded revision loop
`generate` → `critique` → loop back to `generate` up to 3 times until
`critique` says APPROVE. Use case: self-correcting output without a human in
the loop, bounded so it can't run away.

### `support-router.yaml` — conditional branching
`classify` picks exactly one of `refund_flow` / `tech_support_flow` /
`general_flow`. Use case: intent-based routing to a specialized responder.

## Requirements

- Python 3.11+, [uv](https://docs.astral.sh/uv/)
- [Ollama](https://ollama.com/) running locally, if any pipeline uses Ollama models
- API keys for any cloud providers referenced in your pipeline YAMLs

## Setup

```bash
uv sync
cp .env.example .env
```

For cloud providers:
```bash
uv sync --extra openai       # GPT models
uv sync --extra anthropic    # Claude models
uv sync --extra gemini       # Gemini models
uv sync --extra all-providers
```

Pull Ollama models referenced by the shipped example pipelines:
```bash
ollama pull llama3.2:3b llama3 qwen3-coder:30b
```

Running multiple Ollama models concurrently (e.g. `consensus-qa.yaml`'s three
parallel roots)? Set `OLLAMA_MAX_LOADED_MODELS` (in Ollama's own environment,
before `ollama serve`) to match, or requests may time out waiting for model
swaps — see `execution.model_timeout_seconds` per pipeline if you need more
headroom while you tune this.

## Run

```bash
uv run uvicorn llm_pipeline.main:app --reload --port 8000
```

### Or with Docker

```bash
cd llm_pipeline
docker build -t llm-pipeline .
docker run -p 8000:8000 -e OLLAMA_BASE_URL=http://host.docker.internal:11434 llm-pipeline
```

Or from the repo root, to run the pipeline server + Ollama together:
```bash
docker compose up
```
See root `docker-compose.yml` for the full env var wiring.

## API

### `GET /health`
```json
{
  "status": "ok",
  "pipelines_dir": "pipelines",
  "default_pipeline_name": "simple-local",
  "available_pipelines": [
    { "name": "simple-local", "description": "...", "filename": "simple-local.yaml" },
    { "name": "consensus-qa", "description": "...", "filename": "consensus-qa.yaml" }
  ]
}
```

### `GET /pipelines`
Same `available_pipelines` list, standalone.

### `GET /pipelines/{name}`
Returns the parsed DAG shape — nodes, models, dependencies, branches, and
loops — so a client can render or introspect a pipeline before running it:
```json
{
  "name": "support-router",
  "description": "...",
  "output_node_candidates": ["refund_flow", "tech_support_flow", "general_flow"],
  "nodes": [
    { "id": "classify", "type": "llm_call", "depends_on": [], "model": "ollama:llama3.2:3b" },
    { "id": "refund_flow", "type": "llm_call", "depends_on": [], "model": "ollama:llama3" }
  ],
  "branches": [
    { "id": "route_by_intent", "from": "classify", "routes": ["refund_flow", "tech_support_flow", "general_flow"] }
  ],
  "loops": []
}
```

### `POST /ask`

Requires an API key if `API_KEYS` is set (see `.env.example`):
```bash
curl -X POST http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"prompt": "What year did the Berlin Wall fall?", "pipeline_name": "consensus-qa", "history": []}'
```

```json
{
  "prompt": "What year did the Berlin Wall fall?",
  "pipeline_name": "consensus-qa",
  "history": []
}
```

Response:
```json
{
  "pipeline_name": "consensus-qa",
  "output_node": "reconcile",
  "final_answer": "All three sources agree: November 9, 1989.",
  "node_outputs": {
    "answer_local": { "node_id": "answer_local", "model_name": "ollama:qwen3-coder:30b", "output": "...", "duration_ms": 1820.4 },
    "reconcile": { "node_id": "reconcile", "model_name": "ollama:llama3", "output": "...", "duration_ms": 4230.6 }
  },
  "loop_iterations": {}
}
```
`output_node` in the response is whichever candidate actually resolved (only
relevant to distinguish from the definition's list when a pipeline uses
branches). `loop_iterations` maps each loop id to how many times it looped
back — `{}` for pipelines with no loops.

### `POST /ask/stream`

Same request body as `/ask`. Streams **node-level** progress via
Server-Sent Events as the pipeline runs, rather than waiting for the whole
DAG to finish — not token-level streaming from each LLM call (that would
mean every provider adapter implementing streaming individually; node-level
works uniformly across all of them via LangGraph's own `astream()`).

```bash
curl -N -X POST http://localhost:8000/ask/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"prompt": "What year did the Berlin Wall fall?", "pipeline_name": "consensus-qa", "history": []}'
```

Response body (`Content-Type: text/event-stream`), one SSE event per line-block:

```
event: node_complete
data: {"node": {"node_id": "answer_local", "model_name": "ollama:qwen3-coder:30b", "output": "...", "duration_ms": 1820.4}}

event: node_complete
data: {"node": {"node_id": "answer_b", "model_name": "ollama:llama3", "output": "...", "duration_ms": 2140.1}}

event: node_complete
data: {"node": {"node_id": "answer_c", "model_name": "ollama:gemma3:12b", "output": "...", "duration_ms": 1990.3}}

event: node_complete
data: {"node": {"node_id": "reconcile", "model_name": "ollama:llama3", "output": "...", "duration_ms": 4230.6}}

event: done
data: {"pipeline_name": "consensus-qa", "output_node": "reconcile", "final_answer": "...", "node_outputs": {...all four, same shape as /ask...}, "loop_iterations": {}}

```

Event types:

| Event | Payload | When |
|---|---|---|
| `node_complete` | `{"node": NodeOutput}` | Every time a graph node finishes. Synthetic internal nodes (the multi-root fan-out node, loop increment nodes) are filtered out — only real pipeline-defined nodes appear here. |
| `loop_iteration` | `{"loop_id": str, "iteration": int}` | A loop's increment node fired — it's about to run another iteration. |
| `done` | Same shape as `AskResponse` | The pipeline finished successfully. Included in full, not just a delta, so a client that only cares about the final result doesn't need to have accumulated every `node_complete` event. |
| `error` | Same `ErrorResponse` shape as every other error in this API | Something failed mid-run. |

**The one thing that's genuinely different from every other endpoint in this
API**: once a `/ask/stream` response starts, the HTTP status is locked at
`200` — headers have already gone out, so there's no way to send back a
different status code partway through. A pipeline failure therefore can't
`raise HTTPException` the way `/ask` does; it's sent as an `error` SSE event
within that `200` response instead, carrying the exact same `ErrorResponse`
payload `/ask` would have returned as an HTTP error body. **Pre-stream**
failures (unknown pipeline, empty prompt, missing API key, rate limit) still
behave exactly like `/ask` — real `401`/`404`/`400`/`429`/`422` responses —
since those are all resolved before any streaming has begun.

## Error handling

**Every response — success or failure — is a Pydantic model, including
genuinely unexpected exceptions.** Three custom exception handlers cover the
entire surface:

- `@app.exception_handler(HTTPException)` — every `HTTPException` raised
  anywhere (an endpoint, or a `Depends()` dependency like
  `require_api_key`/`enforce_rate_limit`)
- `@app.exception_handler(RequestValidationError)` — FastAPI's automatic
  `422` when a request body fails schema validation
- `@app.exception_handler(Exception)` — a catch-all for anything not already
  handled above (a genuine bug slipping past intended error handling),
  returned as `500`, so there's no path where an error can bypass this
  contract entirely

All three build the **same shape** via one shared `_build_error_response()`
helper:

```json
{
  "timestamp": "2026-08-04T06:25:52.813Z",
  "status": 404,
  "error": "Not Found",
  "message": "No pipeline named 'does-not-exist'",
  "request": "POST /ask",
  "exceptionUID": "a1b2c3d4e5f6",
  "details": {},
  "validations": []
}
```

| Field | Meaning |
|---|---|
| `timestamp` | UTC, when the error was handled |
| `status` | HTTP status code (int) |
| `error` | The HTTP reason phrase for that code (`"Not Found"`, `"Too Many Requests"`, etc.) |
| `message` | Human-readable detail — what a plain `HTTPException(detail=...)` used to surface alone |
| `request` | `"<METHOD> <path>"` of the request that failed |
| `exceptionUID` | Same value as the `X-Request-ID` response header — ties this error directly to server log lines carrying the same id (see `logging_context.py`) |
| `details` | Extra structured context; currently populated for rate-limit errors (`retry_after_seconds`), `{}` otherwise |
| `validations` | One entry per field problem, **only** non-empty for `422` schema validation errors — each entry is `{"field": ..., "message": ..., "type": ...}` |

| Situation | Status | `error` |
|---|---|---|
| Missing/invalid API key (when `API_KEYS` is set) | `401` | Unauthorized |
| Request body fails schema validation | `422` | Unprocessable Entity |
| Prompt/history exceeds length caps, or empty prompt | `400` | Bad Request |
| `pipeline_name` doesn't match any file | `404` | Not Found |
| Rate limit exceeded | `429` | Too Many Requests — `Retry-After` header + mirrored in `details.retry_after_seconds` |
| A node fails after retries are exhausted, or a loop hits `max_iterations` with `on_max_iterations: fail` | `503` | Service Unavailable — `message` names which node/loop |
| No output_node candidate produced a result, or any other anticipated pipeline error | `502` | Bad Gateway |
| A genuinely unexpected exception (a bug) | `500` | Internal Server Error |

`pipeline_name` is validated against a strict filename-safe pattern
(`^[a-zA-Z0-9_-]+$`) before being used to build a filesystem path.

Every endpoint also documents its possible error responses in OpenAPI via
`responses={...}` in the route decorator (see `_ERROR_RESPONSES` in
`main.py`) — purely descriptive for `/docs`, since the handlers above
already enforce the shape at runtime regardless of what's declared.

## Testing

```bash
uv run ruff check .
uv run pytest
uv run mypy llm_pipeline/
uv run pyright
```

`ruff` covers what neither type checker looks at: unused imports, import
ordering, and common bug-prone patterns (`flake8-bugbear` — e.g. mutable
default arguments). It's deliberately **not** configured to duplicate
`mypy`/`pyright`'s job — annotation-completeness rules (`ANN`) are excluded
from `[tool.ruff.lint]` in `pyproject.toml` for exactly that reason. One
FastAPI-specific gotcha it's pre-configured around: `flake8-bugbear`'s B008
rule normally flags any function call used as a default argument value,
which is precisely FastAPI's own recommended DI pattern
(`x: X = Depends(get_x)`) — `extend-immutable-calls` in the ruff config
tells it `Depends`/`Header`/`Query`/`Path` are safe here.

`ruff format` isn't enforced in CI yet — this codebase predates ruff and
hasn't had a full formatting pass run against it once, so turning that on
immediately would surface a wall of formatting diffs unrelated to any real
change. Worth adding once that one-time pass has happened.

Both type checkers are run deliberately, not redundantly — they use different
type-checking algorithms and occasionally disagree, which is useful signal
rather than noise. `pyright` also drives VSCode's Pylance extension, so the
`[tool.pyright]` config in `pyproject.toml` keeps CI in sync with what you
already see live in the editor. `pyright`'s scope (`llm_pipeline/` +
`tests/`) is slightly wider than the documented `mypy` command above since
the test suite was brought to the same strict standard as the package
itself — see `tests/conftest.py` and friends for examples of that.

**VSCode/Pylance**: select the uv-managed interpreter explicitly
(`Cmd/Ctrl+Shift+P` → "Python: Select Interpreter") — it's the `.venv/bin/python`
inside this project folder, since `uv sync` always creates its virtualenv
there.

- `tests/test_safe_eval.py` — the sandboxed expression evaluator: allowed
  operations, and explicit rejection of chaining and code-injection attempts.
- `tests/test_pipeline_config.py` — schema/DAG validation against fixture
  YAML files: cycles, dangling deps, unresolved template refs, duplicate ids,
  branch/loop misconfigurations (missing default route, bad targets, unsafe
  expressions, conflicting conditional edges, dual conditional sources).
  Confirms every real pipeline in `pipelines/` passes validation.
- `tests/test_dag_builder.py` — executes compiled graphs with mocked
  providers (dependency injection via `monkeypatch`, no live Ollama/network
  needed): parallel siblings, joins, multi-root fan-out, node failure
  propagation, branch routing (only the matching route runs), and loop
  behavior (revises until approved, proceeds or fails on max_iterations).
- `tests/test_history.py` — conversation-context folding.

## Robustness & security features

- **Authentication** (`auth.py`) — `/ask` and `/pipelines/*` require an API
  key via `Authorization: Bearer <key>` or `X-API-Key: <key>`, checked with
  constant-time comparison (`secrets.compare_digest`). **Disabled by default**
  (empty `API_KEYS`) for local dev convenience — a startup warning is logged
  when this is the case. `/health` is always open (load balancer probes).
- **Rate limiting** (`rate_limit.py`) — a per-process, per-API-key (or
  per-IP if auth is disabled) fixed-window limiter, default 60 req/min.
  Single-instance only; see the module docstring for the multi-instance caveat.
- **Retries with backoff** (`providers/resilience.py::generate_with_retry`) — transient
  failures (`ProviderError`) get retried with exponential backoff, configurable
  per pipeline via `execution.max_retries` / `execution.retry_backoff_seconds`.
- **Circuit breaker** (`providers/resilience.py::CircuitBreaker`) — after N consecutive
  failures for a given model (`CIRCUIT_BREAKER_FAILURE_THRESHOLD`), that model
  is skipped entirely (fails fast, no network call) for a cooldown period
  (`CIRCUIT_BREAKER_COOLDOWN_SECONDS`) before a trial call is allowed again.
  Composes with retries — the breaker can short-circuit before a retry loop
  even starts.
- **Request correlation IDs** (`logging_context.py`) — every request gets an
  id (reused from an incoming `X-Request-ID` header, or generated), injected
  into every log line automatically via a logging filter, and echoed back as
  a response header — so concurrent requests' logs can be told apart.
- **Prompt/history length caps** — `MAX_PROMPT_LENGTH` /
  `MAX_HISTORY_TURN_LENGTH` reject oversized input with a `400` before it
  ever reaches a model. Not a substitute for real prompt-injection defenses,
  but cheap insurance against runaway token cost.
- **Startup pipeline validation** — every `pipelines/*.yaml` file is
  re-validated (schema only, no real model calls) when the server starts;
  failures are logged clearly rather than only surfacing on first request.
- **Path-traversal safety** — `pipeline_name` is validated against
  `^[a-zA-Z0-9_-]+$` before being used to build a filesystem path.
- **Read-only, stateless endpoints** — no "upload a pipeline" or "activate a
  pipeline" mutation endpoint exists. Treat pipeline YAML files as
  version-controlled, code-reviewed artifacts baked into the deployment.
- **Loop/branch conditions never use `eval()`** — `safe_eval.py`'s small
  sandboxed AST-based evaluator is the only thing that runs YAML-supplied
  expressions.
- **CI** (`.github/workflows/ci.yml`) — validates every pipeline YAML file,
  runs `mypy --strict` + `pytest`, and type-checks both TypeScript clients on
  every push/PR.
- **Docker** (`Dockerfile`, root `docker-compose.yml`) — reproducible
  deployment: pipeline server + Ollama, both configurable via environment
  variables matching `.env.example`.

Tested in `tests/test_auth.py`, `tests/test_rate_limit.py`,
`tests/test_circuit_breaker.py` (all using dependency injection / mocked
providers — no live network needed).

### Still not implemented

- No shared rate-limit store across multiple server instances (each instance
  enforces its own limit independently).
- No structured (JSON) log *output* — request IDs are injected into
  human-readable log lines, not a machine-parseable format; adding that is a
  formatter change, not an architecture change.
- Deeper prompt-injection defenses beyond length caps (e.g. detecting
  attempts to manipulate downstream node prompts via conversation history).
- Streaming `/ask` responses.

## Deliberately deferred (not in this version)

- **Dynamic map-reduce fan-out** (`Send` API — "run this node once per item
  in a runtime-determined list") — needed for batch/RAG-style workloads.
- **Non-`llm_call` node types** (retrieval, tool execution, human-approval
  gates) — the `type` field exists now to make adding these a non-breaking change.
- **Token-level streaming** from each individual LLM call — `POST
  /ask/stream` streams node-level progress (see the API section above),
  which works uniformly across every provider via LangGraph's own
  `astream()`. Streaming individual tokens within a single node's LLM call
  would mean every provider adapter (`providers/ollama.py`, `openai.py`,
  etc.) implementing its own streaming API individually — a larger,
  separate undertaking left for later.

## Conversation history

Implemented as **raw replay**: every prior turn is concatenated as plain text
into `{{ input }}` before a run, capped per-pipeline by
`execution.max_history_turns`. Token cost grows with conversation length; for
long-running conversations, consider summarizing older turns via a cheap
model instead of replaying them verbatim — not implemented here.
