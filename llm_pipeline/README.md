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
  finish — a join, also automatic (see "Joins after branches and loops" for
  the one exception).
- **`branches`**: a node's output picks ONE of several routes — the others
  never execute for that request. A route can start one node or several.
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
├── health.py                 GET /health, /pipelines
├── editing.py                GET/PUT/DELETE /pipelines/{name}, models, presets, …
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

### Per-node model settings

Every field below is optional. Unknown keys are rejected (a typo like
`temprature` fails validation instead of being silently ignored).

```yaml
  - id: reconcile
    depends_on: [answer_a, answer_b]
    model:
      provider: ollama
      model: llama3
      temperature: 0.2          # 0–2
      options:                  # Ollama only — rejected for other providers
        num_ctx: 8192           # context window (tokens)
        num_predict: 512        # max tokens to generate (-1 = unlimited)
        top_p: 0.9
        top_k: 40
        repeat_penalty: 1.1
        repeat_last_n: 64
        seed: 42                # reproducible output
        stop: ["###"]
        mirostat: 0             # 0 off, 1, or 2
        mirostat_eta: 0.1
        mirostat_tau: 5.0
        tfs_z: 1.0
        num_gpu: 1
        num_thread: 8
        keep_alive: "5m"        # how long Ollama keeps the model loaded
        format: json            # constrain output to valid JSON
    system_prompt: "You are a careful reconciler."   # a real system message, any provider
    prompt_template: "{{ answer_a.output }} vs {{ answer_b.output }}"
    layout: { x: 420, y: 120 }  # where the visual editor draws it; ignored at runtime
```

Unset options fall back to the model's own defaults (its Modelfile
`PARAMETER`s). Ollama nodes are called through `ChatOllama`
(`/api/chat`), so `system_prompt` goes through the model's chat template.

Templates are **Jinja2** — you get `{% if %}`/`{% for %}` etc., not just plain
substitution. This matters for loops (see below): a loop's `back_to` target
references a node that genuinely hasn't run yet on the first iteration, so its
template needs `{% if x is defined %}` around that reference.

Every template can use:

| Variable | Contains |
|---|---|
| `{{ input }}` | the new message, with the earlier conversation folded in (see "Conversation history") |
| `{{ question }}` | just the new message |
| `{{ history }}` | just the earlier conversation (empty on the first message) |
| `{{ <node>.output }}` | another node's output — that node must be in `depends_on` |

`input`, `question` and `history` are therefore reserved and can't be node ids.

Templates are rendered in Jinja's **sandbox**: they can't reach Python
internals — `{{ input.__class__ }}` renders nothing, and going further
(`{{ input.__class__.__mro__ }}`) fails the node with a security error.
That matters because editor clients can save templates.

### Pipeline-wide settings

```yaml
execution:
  max_concurrency: 2        # at most 2 nodes call models at once (default: no limit)

defaults:                   # every node inherits these unless it sets its own
  model: { provider: ollama, model: llama3, temperature: 0.4, options: { keep_alive: 10m } }
  system_prompt: "Answer in English."
  strip_reasoning: true     # drop <think>…</think> from outputs (qwen3, deepseek-r1, …)

nodes:
  - id: classify
    include_history: false  # sees only the new message
    prompt_template: "Classify: {{ question }}"   # no model: uses defaults.model
  - id: answer
    depends_on: [classify]
    model: { provider: ollama, model: gemma3:12b }  # own model; temperature 0.4 and
                                                    # keep_alive inherited from defaults
    strip_reasoning: false  # overrides the pipeline default
    prompt_template: "{{ input }}"
```

Inheritance rules: a node without `model` uses `defaults.model` entirely; a
node with its own model still takes the default's `temperature` if it sets
none and — when both are Ollama — each Ollama option it doesn't set itself.
`system_prompt` and `strip_reasoning` fall back to the defaults when the
node leaves them out. Every `llm_call` node must end up with a model.

### Test cases

A pipeline can carry test cases — messages to run it with, and what each
answer must satisfy. The engine ignores them; editor clients run them
(`POST /pipelines/test`, the web **Tests** view, the CLI's `/test`) and
compare models on them.

```yaml
tests:
  judge:                     # grades `judge` expectations; needs the allowlist like any model
    model: { provider: ollama, model: llama3.2:3b }
    # prompt: …              # optional; variables: question, answer, criterion
  cases:
    - name: capital
      input: What is the capital of France?
      expect:
        - contains: Paris                   # case-insensitive
        - not_contains: I'm not sure
        - check: 'output.startswith("The")' # same language as branch conditions
        - judge: answers in one sentence    # PASS/FAIL by the judge model, with its reason
    - name: open question                   # no expectations: just shows the answer
      input: Tell me a joke
```

Each case runs with no conversation before it; its answer is the output
node's. Case names must be unique, and a `judge` expectation needs
`tests.judge`.

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
  not the first time a request happens to hit that branch. Besides `output`,
  a condition can read `question` — the user's new message, as
  `{{ question }}` in prompts: `'"URGENT" in question'` routes on what the
  user wrote without a classifier call. `exit_when` and test `check`s can
  read it too.
- `to` can list several nodes — `to: [tech_answer, security_check]` — which
  all start, in parallel, when that route is taken.
- A branch's route targets (`refund_flow`, etc.) have `depends_on: []` but are
  **not** automatic entry points — they only run when actually routed to.
  `output_node` must be a **list** of candidates once a branch means only one
  of several possible "final" nodes runs per request; the server picks
  whichever one actually has a result.

### Classifier nodes — `labels`

```yaml
  - id: classify
    labels: [REFUND, TECHNICAL, GENERAL]
    prompt_template: |
      Classify this support request as REFUND, TECHNICAL or GENERAL: {{ input }}
```

A node with `labels` answers with exactly one of them: its output is
matched to a label (ignoring `<think>` reasoning, case, quotes, markdown and
trailing punctuation — the whole answer, then its first line, then a label
appearing in it as a whole word) and replaced by that label as written.
An answer naming none of them, or more than one, fails the run with an
error naming the node. Routes can then test `output == "REFUND"`, and a
route no label can ever take (a typo, or one an earlier route always
catches first) is a load-time error. Routes that also read `question` are
left out of that check — whether they match depends on the message.

### Joins after branches and loops

A join normally waits for all of its inputs. That's only safe when they're
guaranteed to run together — so it waits for all when they come after the
same route (`to: [a, b]`), are re-run by the same loop, or run
unconditionally. When they don't — inputs behind *different* routes (only
one of them ever runs), or one input re-run by a loop and another that runs
once — waiting for all could wait forever, so the join runs after
whichever arrive instead; guard such templates with `{% if x is defined %}`.
See `pipeline_config/activation.py`.

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
  `fail` raises `PipelineExecutionError` instead. For a loop nested inside
  another, the cap is per pass of the outer loop: each outer pass starts it
  over.
- Since `node_outputs` only ever holds the **latest** result per node id,
  `generate`'s entry is automatically its most-revised version by the time the
  loop exits — regardless of how many iterations happened.
- The `{% if critique is defined %}` guard is required, not optional: on the
  very first pass, `critique` genuinely hasn't run yet, and Jinja raises
  immediately on an unguarded `{{ critique.output }}` reference to an
  undefined variable — so loading the pipeline rejects a missing guard
  (see "Validation" below).

## Validation, at load time (`pipeline_config/validation.py`)

- **No cycles in `depends_on`** — this check applies to the base DAG only.
  Loops are a deliberately *separate* mechanism and are expected to introduce
  real cycles in the compiled graph; that's the entire point of them.
- **No dangling dependencies / branch or loop targets** — every reference
  must point to a real node id.
- **Exactly one default route per branch**; every non-default route must set
  `when`. A route's `to` list can't be empty or name a node twice.
- **Classifier `labels`**: at least two, none empty, no duplicates (ignoring
  case) — and every route from a classifier must be reachable by one of its
  labels.
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
- **Outputs that are sometimes missing must be guarded** — a prompt that
  uses an output which certainly hasn't run on some runs of its node must
  wrap that part in `{% if x is defined %}`: a loop's `back_to` reading its
  `from_` node (not run yet on the first pass), or a join reading an input
  behind a branch route its other inputs don't need. The error names the
  node, so the editor highlights it. Cases that depend on timing are left
  to the run-time error, which also names the node.
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
Returns the pipeline as stored — its complete definition (nodes, prompts,
models, branches, loops, layout), in exactly the shape of its YAML file,
plus its `revision` — also the response's `ETag` header — to send back as
`If-Match` when saving it with `PUT /pipelines/{name}`. What you read is
what you save:
```json
{
  "definition": {
    "name": "support-router",
    "description": "...",
    "nodes": [
      { "id": "classify", "depends_on": [], "model": { "provider": "ollama", "model": "llama3.2:3b", "temperature": 0.0 }, "prompt_template": "..." }
    ],
    "branches": [
      { "id": "route_by_intent", "from": "classify", "routes": [{ "when": "\"REFUND\" in output", "to": "refund_flow" }, { "default": true, "to": "general_flow" }] }
    ],
    "output_node": ["refund_flow", "tech_support_flow", "general_flow"]
  },
  "revision": "3f2a9c01b7de4e55",
  "has_comments": true
}
```
A client that draws the pipeline derives its structure from this definition
(`detailFromDefinition()` in the shared client package) — the same way it
draws an unsaved draft.

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
    "answer_local": { "node_id": "answer_local", "model_name": "ollama:qwen3-coder:30b", "output": "...", "duration_ms": 1820.4,
      "usage": { "prompt_tokens": 412, "completion_tokens": 96, "generation_ms": 1540.2, "context_window": 4096 } },
    "reconcile": { "node_id": "reconcile", "model_name": "ollama:llama3", "output": "...", "duration_ms": 4230.6, "usage": null }
  },
  "loop_iterations": {}
}
```
`output_node` in the response is whichever candidate actually resolved (only
relevant to distinguish from the definition's list when a pipeline uses
branches). `loop_iterations` maps each loop id to how many times it looped
back — for a loop nested in another, in the outer loop's last pass — `{}`
for pipelines with no loops.

**Token usage.** Each node output carries `usage` — what the model's backend
reported for its (last) call, `null` when it reports nothing:
`prompt_tokens`, `completion_tokens`, `generation_ms` (time spent generating,
so `completion_tokens / generation_ms` is its speed), `context_window` —
how many tokens the model could see: the node's `num_ctx`, else the context
the loaded Ollama model ran the call with (from Ollama's `/api/ps`, asked
right after the call) — and `prompt_chars`, the length sent. **Ollama
silently drops the start of a prompt longer than the window**, and then
reports only the tokens it kept (often about half the window), so both
clients warn when the prompt tokens reach the window *or* the prompt is
longer than the window could hold even at 5 characters per token.

**Stopping a run.** If the client goes away — a Stop button, Ctrl+C in
the CLI, a closed tab — the server cancels the run within about half a
second, and with it the model calls in progress (Ollama stops generating
when its request is dropped). This holds for `/ask`, `/ask/stream`, the
OpenAI-compatible endpoint and test runs; see `disconnects.py`.

**Re-running from a node.** Add `"rerun": {"from_node": "reconcile",
"outputs": {<node>: <output>, …}}` (typically the previous run's node
outputs, with the same `prompt` and `history`): that node and every node
after it call their models again; every other node reuses its output
(`replayed: true` on its `node_start`/`node_complete`, no model call).
A reused node replays only on its first execution — if a loop sends the run
back to it, it runs for real — and a reused branch source takes the same
route as before. See `rerun.py`.

### `POST /ask/stream`

Same request body as `/ask`. Streams progress via Server-Sent Events as
the pipeline runs, rather than waiting for the whole DAG to finish: when
each node starts, the **text each node's model is writing, token by
token**, when it completes, and the final result. Token streaming needs no
code in the provider adapters — LangChain chat models stream on their own
when LangGraph's `messages` stream mode is listening.

```bash
curl -N -X POST http://localhost:8000/ask/stream \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"prompt": "What year did the Berlin Wall fall?", "pipeline_name": "consensus-qa", "history": []}'
```

Response body (`Content-Type: text/event-stream`), one SSE event per line-block:

```
event: node_start
data: {"node_id": "answer_local", "model_name": "ollama:qwen3-coder:30b", "attempt": 1, "prompt": "Answer this question accurately and concisely: What year did the Berlin Wall fall?", "system": null}

event: node_start
data: {"node_id": "answer_b", "model_name": "ollama:llama3"}

event: node_token
data: {"node_id": "answer_local", "text": "The Berlin"}

event: node_token
data: {"node_id": "answer_b", "text": "It fell on"}

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
| `node_start` | `{"node_id": str, "model_name": str, "attempt": int, "prompt": str, "system": str \| null, "replayed": bool}` | A node is starting its model call, with exactly what the model receives: `prompt` is the rendered template (the run's input and its dependencies' outputs filled in), `system` the node's system prompt — emitted by the node itself (LangGraph's `custom` stream mode), so clients show exactly what is running instead of guessing from the graph shape. Parallel siblings each get one; a node re-run by a loop gets one per iteration; a retry after a failed call sends another with `attempt` 2+ (discard that node's streamed text so far). |
| `node_token` | `{"node_id": str, "text": str}` | A piece of text the node's model just generated. A node's tokens since its latest `node_start` concatenate to its output so far; `node_complete` then carries the authoritative full output. Parallel nodes' tokens interleave. |
| `node_complete` | `{"node": NodeOutput}` | Every time a graph node finishes, with its `usage` (see `/ask`) and `replayed`. Synthetic internal nodes (the multi-root fan-out node, loop increment nodes) are filtered out — only real pipeline-defined nodes appear here. |
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

## OpenAI-compatible endpoints

Every pipeline is also a "model" behind an OpenAI-style API, so tools that
speak it — Open WebUI, Continue, the openai SDKs — can chat with pipelines:

```bash
curl http://localhost:8000/openai/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $API_KEY" \
  -d '{"model": "consensus-qa", "messages": [{"role": "user", "content": "When did the Berlin Wall fall?"}], "stream": true}'
```

- `GET /openai/v1/models` lists the pipelines; `POST /openai/v1/chat/completions`
  runs the one named by `model`. Point a client's "OpenAI base URL" at
  `http://<server>/openai/v1`; the API key (when `API_KEYS` is set) goes in
  as the usual Bearer token.
- These endpoints used to be at `/v1`. They moved so that `/v1/` stays free
  for this API's own versioning; a client still pointed at
  `http://<server>/v1` now gets 404s — change its base URL.
- The last message must be the user's; earlier user/assistant pairs become
  the conversation history (the pipeline's history settings apply). System
  messages and generation parameters (`temperature`, `max_tokens`, …) are
  ignored — a pipeline's nodes have their own.
- `stream: true` sends `chat.completion.chunk` events. The output node's
  text streams token by token when the pipeline has exactly one output
  node, no loops and no reasoning stripping on it; otherwise (a loop would
  stream every draft) the answer arrives in one piece at the end. If the
  output node fails mid-answer and retries, a `[retrying after an error]`
  line marks the restart. `stream_options.include_usage` adds OpenAI's
  final usage chunk.
- `usage` sums the tokens of every model call in the run.
- Errors use OpenAI's shape — `{"error": {"message", "type", "code", …}}`;
  a failure mid-stream arrives as a `data:` event carrying `error`.

## Editing pipelines from clients

The web editor and the CLI's edit commands (`/edit`, `/set`, `/save`, …)
read and write pipelines through these endpoints. **Writing is off by
default**: set `PIPELINE_EDITING_ENABLED=true` to allow it, and set
`API_KEYS` too on anything reachable beyond localhost — saving rewrites
files in `PIPELINES_DIR`.

Editing is **refused** (writes return 403, `/health` reports
`editing_enabled: false` with an `editing_disabled_reason`) when
`CORS_ALLOWED_ORIGINS` is `*` and no `API_KEYS` are set: in that setup any
website open in your browser could send write requests to the server.
Set `API_KEYS`, or list the actual client origins (e.g.
`http://localhost:5173,http://localhost:8080`).

| Endpoint | Purpose |
|---|---|
| `GET /models` | Models an editor may pick: every model installed on `OLLAMA_BASE_URL`, plus the cloud models listed in `EDITOR_CLOUD_MODELS` (`provider:model`, comma-separated). `?refresh=true` skips the short cache. |
| `GET /models/ollama/{name}` | An installed Ollama model's limits — max context length, parameter size, quantization, family — for editor hints. 404 when it isn't installed or Ollama can't be reached. |
| `GET /pipelines/{name}` | The full definition (prompts, options, layout) plus its `revision` and whether the file has YAML comments (`has_comments`) — what `PUT` takes back. |
| `POST /pipelines/validate` | Body `{"definition": {...}}` or `{"yaml": "..."}`. Validates without saving and returns `{definition, yaml, model_issues, warnings}` — the same call serves live validation, import (YAML in) and export (canonical YAML out). `warnings` flags settings beyond what a model supports (e.g. `num_ctx` above its maximum context) but never blocks a save. A 422 names the offending node in `details.node_id`. |
| `PUT /pipelines/{name}` | Body `{"definition": {...}}`, and a header saying whether this creates or updates: `If-None-Match: *` creates (412 `ALREADY_EXISTS` if the name is taken); `If-Match: "<revision>"` updates only the version you loaded (412 `REVISION_CONFLICT` if someone saved in between; `If-Match: *` updates whatever is there). Neither is `428 PRECONDITION_REQUIRED` — a blind overwrite could undo someone else's save. Writes `pipelines/<name>.yaml` atomically; the response's `ETag` is the new revision, and the next run uses it. |
| `DELETE /pipelines/{name}` | Moves the file to `pipelines/.deleted/<name>.<timestamp>.yaml` — recoverable by moving it back. `If-Match: "<revision>"` (optional) refuses the delete if the file changed since loaded (412); the server's `DEFAULT_PIPELINE_NAME` can't be deleted (409). The old `?revision=` query is refused (422) rather than ignored. |
| `POST /pipelines/preview` | Body `{"definition": {...}, "node_id": "...", "prompt": "...", "history": [...], "outputs": {<node>: <text>}}`. What that node would receive — `{prompt, system, missing}` — rendered by the same code a run uses, from a definition that needn't be saved. Inputs with no output given appear as `<node's output>` placeholders (listed in `missing`); older turns a run would summarize are left out (previews never call a model). Needs editing enabled — it renders client-supplied templates. |
| `POST /pipelines/test` | Body `{"definition": {...}, "cases": [names], "inputs": [messages], "variants": [{"label", "models": {<node>: <model block>}}]}`. Runs the definition's test cases (see "Test cases") — all, or the named ones, plus one-off `inputs` — and again for each variant (the same pipeline with other models for some nodes; at most 3), streaming `case_start` / `case_result` per case and variant, then `tests_done` with per-variant totals. Every variant passes validation and the model allowlist. Needs editing enabled — it runs client-chosen models. |
| `GET /presets`, `GET /presets/{name}`, `PUT /presets/{name}`, `DELETE /presets/{name}` | The node library ("saved nodes" in the clients): a node's whole configuration — `model` (with options), `system_prompt`, `prompt_template`, `include_history`, `strip_reasoning`, plus a `description` — stored as `presets/<name>.yaml` (`PRESETS_DIR`). The model passes the allowlist and the prompt must parse; which node outputs it references is checked when it lands in a pipeline. Adding or applying one copies its values into a node; pipelines never reference presets by name. Deleting moves the file to `presets/.deleted/`. Writes are last-write-wins unless you send `If-Match` (the `ETag` from reading it) or `If-None-Match: *`, as for pipelines. |

What a save goes through, in order — and nothing is written unless all of
it passes:

1. The **same** validator the YAML loader uses (`PipelineDefinition`).
2. The **model allowlist**: an Ollama model must be installed on the
   configured Ollama server, a cloud model must be in
   `EDITOR_CLOUD_MODELS`. If Ollama can't be reached the save is refused
   (fail closed). A model the stored pipeline *already* uses is accepted
   as-is, so editing just a prompt never needs Ollama to be up.
3. The `If-Match` / `If-None-Match` check against the file on disk, then an
   atomic write.

**Saving keeps hand-written comments and layout.** The new definition is
merged into the file's existing YAML document (via `ruamel.yaml`
round-tripping) instead of replacing it: comments, key order, quoting and
`{ … }` flow style survive, nodes/branches/loops are matched by id, and
settings the file left implicit are only written out when they change.
Saving an unchanged pipeline leaves the file byte-identical. The result is
re-validated and must mean exactly the saved definition — if it wouldn't,
the file is written in canonical form instead and the response says
`comments_preserved: false`. New pipelines are written canonically. The
compiled-graph cache reloads a pipeline whenever its file changes, so
saves (and hand edits) apply without a restart.

## Error handling

**Every response — success or failure — is a Pydantic model, including
genuinely unexpected exceptions.** Custom exception handlers cover the
entire surface:

- `@app.exception_handler(HTTPException)` — every `HTTPException` raised
  anywhere (an endpoint, or a `Depends()` dependency like
  `require_api_key`/`enforce_rate_limit`). The server raises `ApiError`
  (`api_error.py`), an `HTTPException` that names its `code`.
- `@app.exception_handler(RequestValidationError)` — FastAPI's automatic
  `422` when a request body fails schema validation
- one handler per domain error the store and validation raise (an invalid
  definition, a model not on the allowlist, a revision conflict, …)
- `@app.exception_handler(Exception)` — a catch-all for anything not already
  handled above (a genuine bug slipping past intended error handling),
  returned as `500`, so there's no path where an error can bypass this
  contract entirely

All of them build the **same shape** via one shared `build_error_response()`
helper:

```json
{
  "timestamp": "2026-08-04T06:25:52.813Z",
  "status": 404,
  "error": "Not Found",
  "code": "PIPELINE_NOT_FOUND",
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
| `code` | Which failure this is — see below. **Branch on this, not on `status`**: failures that share a status (a `412` is a stale revision or a taken name) have different codes |
| `message` | Human-readable detail — what a plain `HTTPException(detail=...)` used to surface alone |
| `request` | `"<METHOD> <path>"` of the request that failed |
| `exceptionUID` | Same value as the `X-Request-ID` response header — ties this error directly to server log lines carrying the same id (see `logging_context.py`) |
| `details` | Extra structured context: `retry_after_seconds` for rate limits, `node_id` (or `loop_id`) when a node is at fault; `{}` otherwise |
| `validations` | One entry per field problem, **only** non-empty for `422` schema validation errors — each entry is `{"field": ..., "message": ..., "type": ...}` |

The codes (`ErrorCode` in `api_schemas.py`). **Each code always comes with
the same status** (`STATUS_BY_CODE` in `api_error.py` — `ApiError` takes its
status from there, so no endpoint can send a different one). A request that
names something that doesn't exist gets a `404` whether the name is in the
path or the body, as OpenAI's API does for an unknown `model`. New codes may
be added, so a client should handle a code it doesn't know by its `status`.

| `code` | Status | When |
|---|---|---|
| `REQUEST_INVALID` | `422` | The request body fails schema validation (`validations` lists each problem), or asks for something contradictory (e.g. both `definition` and `yaml`) |
| `UNAUTHENTICATED` | `401` | Missing or unknown API key (when `API_KEYS` is set) |
| `RATE_LIMITED` | `429` | Rate limit exceeded — `Retry-After` header, mirrored in `details.retry_after_seconds` |
| `INTERNAL_ERROR` | `500` | A genuinely unexpected exception (a bug) — `message` stays generic; quote `exceptionUID` when reporting it, the server log has the rest |
| `NAME_INVALID` | `400` | A pipeline or preset name that isn't filename-safe (`^[a-zA-Z0-9_-]+$`) |
| `PIPELINE_NOT_FOUND` | `404` | No pipeline with that name |
| `PRESET_NOT_FOUND` | `404` | No preset with that name |
| `MODEL_NOT_FOUND` | `404` | An Ollama model that isn't installed (or Ollama is unreachable) |
| `DEFINITION_INVALID` | `422` | A submitted pipeline or preset fails validation — `details.node_id` names the node at fault, if one |
| `MODEL_NOT_ALLOWED` | `422` | A submitted definition uses a model the server doesn't allow — `details.node_id` likewise |
| `EDITING_DISABLED` | `403` | Writes are off on this server; `message` says why |
| `ALREADY_EXISTS` | `412` | A create (`If-None-Match: *`) for a pipeline or preset name that is taken |
| `REVISION_CONFLICT` | `412` | `If-Match` didn't hold: the pipeline or preset changed (or was deleted) since it was loaded — reload before saving |
| `PRECONDITION_REQUIRED` | `428` | Saving a pipeline without `If-Match` or `If-None-Match` |
| `PIPELINE_PROTECTED` | `409` | Deleting the server's default pipeline |
| `INPUT_INVALID` | `400` | An empty prompt, or an OpenAI chat that doesn't end with the user's message |
| `INPUT_TOO_LARGE` | `400` | The prompt, a history turn or a re-run's outputs exceed the configured length caps |
| `NODE_NOT_FOUND` | `404` | `rerun.from_node`, a prompt preview's `node_id`, or a test variant's node isn't in the pipeline |
| `TEST_CASE_NOT_FOUND` | `404` | A test run names a case the definition doesn't have |
| `TEMPLATE_RENDER_FAILED` | `422` | A prompt preview's template can't be rendered |
| `PIPELINE_RUN_FAILED` | `502` | A node fails — its model call after retries are exhausted, or its prompt can't be rendered — or a loop hits `max_iterations` with `on_max_iterations: fail` (`details` names the node or loop), or no `output_node` candidate produced a result |
| `REQUEST_CANCELLED` | `499` | The client disconnected mid-run — logged only, nobody receives it |

`pipeline_name` is validated against a strict filename-safe pattern
(`^[a-zA-Z0-9_-]+$`) before being used to build a filesystem path.

Every endpoint also documents its possible error responses in OpenAPI via
`responses={...}` in the route decorator (see `_ERROR_RESPONSES` in
`main.py`) — purely descriptive for `/docs`, since the handlers above
already enforce the shape at runtime regardless of what's declared.

## Testing

```bash
uv run ruff check .
uv run ruff format --check .   # `uv run ruff format .` to apply
uv run pytest
uv run mypy .
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

`ruff format --check` runs in CI: the whole codebase has been formatted
once, so the check only ever flags new, unformatted changes.

Both type checkers are run deliberately, not redundantly — they use different
type-checking algorithms and occasionally disagree, which is useful signal
rather than noise. `pyright` also drives VSCode's Pylance extension, so the
`[tool.pyright]` config in `pyproject.toml` keeps CI in sync with what you
already see live in the editor. Both check `llm_pipeline/` *and* `tests/`:
the test suite is held to the same strict standard as the package, since a
test can hide a real type problem as easily as the code it tests.

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
  runs ruff (lint and formatting), `mypy --strict` and pyright over the code
  and its tests, `pytest`, the shared client's, CLI's and web client's
  tests, and type-checks the TypeScript (tests included) on
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

## Deliberately deferred (not in this version)

- **Dynamic map-reduce fan-out** (`Send` API — "run this node once per item
  in a runtime-determined list") — needed for batch/RAG-style workloads.
- **Non-`llm_call` node types** (retrieval, tool execution, human-approval
  gates) — the `type` field exists now to make adding these a non-breaking change.
  The roadmap puts deterministic node kinds (transform, validate, …) and
  typed, structured outputs at Stage 3 and retrieval/tool nodes at Stage 4
  (`specs/ROADMAP.md`).

## Conversation history

Clients send the earlier turns with every request (the server keeps no
conversation state). Per pipeline:

```yaml
execution:
  max_history_turns: 6      # most recent turns kept verbatim (0: history off)
history:
  intro: "Conversation so far:"                           # first line of the history in {{ input }}
  turn_template: "User: {{ prompt }}\nAssistant: {{ answer }}"   # how each turn is written
  max_chars: 4000           # budget for the verbatim turns; oldest dropped first
  remember: [classify]      # also remember these nodes' outputs with each turn
  summarize:                # condense turns that don't fit instead of dropping them
    model: { provider: ollama, model: llama3.2:3b }
    prompt: "Summarize briefly:\n\n{{ history }}"      # must include {{ history }}
```

- The defaults reproduce the original fixed format exactly.
- `turn_template` variables: `prompt`, `answer`, and `outputs` (the remembered
  node outputs of that turn, e.g. `{{ outputs.classify }}`). The default
  template lists remembered outputs between the prompt and the answer.
- **Remembered outputs**: `/ask` and the stream's `done` event return
  `remembered: {node: output}`; clients store it with the turn and send it
  back as that turn's `outputs`. Both bundled clients do this.
- **Summaries** cost one model call per message once the conversation no
  longer fits, using the pipeline's timeout, retries and circuit breaker. If
  the summary call fails, the older turns are simply dropped (a warning is
  logged) — the run itself never fails because of it.
- A node with `include_history: false` gets just the new message as
  `{{ input }}` and an empty `{{ history }}`.
