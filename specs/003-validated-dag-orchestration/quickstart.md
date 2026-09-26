# Quickstart: Validating the Stage 1 DAG Runner

Runnable checks proving each user story from [spec.md](./spec.md) works
end to end. Each section maps to that story's "Independent Test".

## Prerequisites

```bash
cd llm_pipeline
uv sync
```

Ollama reachable at `OLLAMA_BASE_URL` (default `http://localhost:11434`)
with at least one model pulled.

AirLLM is optional and extras-gated. Without it, everything except the
heavy-model sections works — that is what `AIRLLM_REQUIRED=false`
(the development default, FR-040) is for:

```bash
uv sync --extra airllm    # Linux + CUDA only; skip on macOS
```

Start the server — **one worker**, mandatory while the heavy model is
in-process:

```bash
uv run uvicorn llm_pipeline.main:app --workers 1 --port 8000
```

Confirm what the process actually holds:

```bash
curl -s localhost:8000/health | jq
```

Expect `ollama_reachable: true` and an `airllm` entry whose `available`
reflects your host. On macOS `available: false` is the correct result,
not a failure.

---

## User Story 1 — Parallel, resource-aware execution (P1)

Run a workflow with a fan-out and a fan-in
([schema reference](./contracts/workflow-schema.md)):

```bash
curl -s -X POST localhost:8000/v1/workflows/document_qa/run \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $API_KEY" \
  -d '{"inputs": {"text": "Deploy at 14:02. Errors at 14:05.", "question": "What caused the outage?"}}' | jq
```

**Expect**: `final_output` plus a `nodes` map with an entry per step, each
carrying `provider`, `physical_model`, `resource_wait_ms`, and
`execution_ms` ([response shape](./contracts/http-api.md)).

**Confirm the fan-out actually overlapped** — the two extract steps
should show overlapping wall-clock windows, and total run time should sit
near the slower of the two rather than their sum (SC-003). With both
declaring `gpu0: 1` they will serialize instead; give them distinct
resources to see genuine overlap.

**Confirm fan-in waits**: `analyze` must not start before both parents
finish. Its `resource_wait_ms` is the visible evidence of it waiting.

**Confirm fail-fast** (FR-023): point one alias at a model Ollama doesn't
have and re-run. Expect a 502, `category: "provider_unavailable"`,
`details.node_id` naming the failing step, and no downstream step in the
response.

---

## User Story 2 — Invalid workflows rejected before execution (P2)

The validation suite is the primary check:

```bash
uv run pytest tests/test_workflow_validation.py -v
```

Every category in the [error catalog](./contracts/workflow-schema.md)
should have a case. To see it by hand, drop a broken file into
`pipelines/` and restart — startup validation reports it without
serving it:

```yaml
# pipelines/broken.yaml — cycle
version: 1
name: broken
max_parallel_nodes: 2
input_fields: [x]
resources: {ollama_server: 1}
models:
  m: {provider: ollama, model: llama3, resources: [ollama_server]}
nodes:
  - {id: a, uses: m, depends_on: [b], prompt: "{{ input.x }}"}
  - {id: b, uses: m, depends_on: [a], prompt: "{{ input.x }}"}
output: a
```

**Expect** a startup log naming the cycle, `broken` absent from
`GET /v1/workflows`, and **zero model calls** (SC-002) — verifiable in
Ollama's own logs.

The highest-value case to check by hand is the hidden dependency, since
it is the one that looks legal:

```yaml
  - {id: summarize, uses: m, depends_on: [], prompt: "{{ nodes.extract.output }}"}
```

> `node 'summarize' references 'extract' in its prompt but does not declare it in depends_on`

---

## User Story 3 — Mixed models sharing hardware (P3)

Requires AirLLM loaded (`/health` shows `airllm.available: true`).

**Shared accelerator serializes** (FR-028, SC-004). Give the Ollama and
AirLLM aliases the same `gpu0: 1`, then fire 10 concurrent runs:

```bash
seq 10 | xargs -P10 -I{} curl -s -X POST \
  localhost:8000/v1/workflows/document_qa/run \
  -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
  -d '{"inputs": {"text": "…", "question": "…"}}' -o /tmp/run-{}.json
```

**Expect** all 10 to succeed — waiting is not failing — with
`resource_wait_ms` climbing across them. Structured logs must show no two
`gpu0` holders overlapping.

**Event loop stays free** (FR-036, SC-007). While a heavy step runs:

```bash
time curl -s localhost:8000/health > /dev/null
```

**Expect** under 1s. A multi-second result means inference is blocking
the loop.

**Loaded exactly once** (FR-034, SC-006): grep startup logs for the
model-load line — exactly one occurrence, before the first request.

**Lease survives cancellation** (FR-031, FR-038) — the subtlest
requirement here, and the one most likely to regress silently. Start a
run using the heavy model, kill the client mid-flight (Ctrl-C), then
immediately submit an Ollama run needing the same `gpu0`. It must wait
for the abandoned inference to genuinely finish rather than starting
straight away. The unit test is authoritative:

```bash
uv run pytest tests/test_resource_pool.py -k cancel -v
```

**Identity mismatch rejected** (FR-039): point an `airllm` alias at a
model this process didn't load. Expect a 500 with
`category: "configuration"`, not an attempt to load it.

---

## Migration checks

**Migrated workflows run** (SC-010):

```bash
for w in simple_local consensus_qa code_review; do
  curl -s -X POST localhost:8000/v1/workflows/$w/run \
    -H 'Content-Type: application/json' -H "X-API-Key: $API_KEY" \
    -d '{"inputs": {"question": "What is 2+2?"}}' \
    | jq -r '"\(.workflow_name): \(.final_output[0:60])"'
done
```

**Parked workflows stay parked**: `support-router` and
`iterative-refinement` live under `pipelines/deferred/`, must not appear
in `GET /v1/workflows`, and must not produce startup validation errors.
They need conditional routing and iteration respectively — see
[research.md §8](./research.md) and the open roadmap question about
iteration having no target stage.

**Clients work against the new contract**:

```bash
cd .. && npm run typecheck
```

---

## Full sweep

```bash
cd llm_pipeline && uv run pytest && uv run mypy . && uv run pyright
```

All three must pass, with no new type-checker suppressions beyond the
existing optional-import pattern (now covering `airllm`/`torch`).
