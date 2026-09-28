# Contract: HTTP API

The service's public surface for Stage 1. Deliberately small: list
workflows, inspect one, run one, check health.

**Stage 1 executes a workflow inside a single request** and returns when
it finishes. Asynchronous submission with run IDs, progress streaming,
and cancellation are Stage 2 — the spec records this as a knowing
compromise. The paths below are chosen so Stage 2 can add
`POST /v1/runs` alongside them without breaking these.

Authentication (`Authorization: Bearer <key>` or `X-API-Key: <key>`) and
rate limiting apply to everything except `/health`, reusing the existing
mechanisms unchanged (FR-052).

---

## `GET /health`

Unauthenticated — orchestrators probe it without credentials.

**200**
```json
{
  "status": "ok",
  "ollama_reachable": true,
  "backends": [
    {"provider": "ollama", "available": true,  "physical_model": null},
    {"provider": "airllm", "available": true,  "physical_model": "Qwen/Qwen3-32B"}
  ]
}
```

`airllm.available` is `false` on a host where the model could not be
loaded under permissive startup (FR-040). `physical_model` reports which
heavy model this process actually holds — the value an `airllm` alias
must match.

**Must answer within 1s even while heavy inference is running** (SC-007).
That assertion is the practical test that inference is off the event
loop.

---

## `GET /v1/workflows`

**200**
```json
{
  "workflows": [
    {"name": "document_qa", "description": "…", "input_fields": ["text", "question"]}
  ]
}
```

Only workflows that loaded and validated successfully appear. Files under
`pipelines/deferred/` are never scanned.

---

## `GET /v1/workflows/{name}`

Structure without execution (FR-044).

**200**
```json
{
  "name": "document_qa",
  "description": "…",
  "input_fields": ["text", "question"],
  "output": "final",
  "max_parallel_nodes": 4,
  "resources": {"gpu0": 1, "ollama_server": 2, "airllm_instance": 1},
  "models": [
    {"alias": "extract_fast",  "provider": "ollama", "physical_model": "qwen3:8b",       "resources": ["gpu0", "ollama_server"]},
    {"alias": "deep_reasoner", "provider": "airllm", "physical_model": "Qwen/Qwen3-32B", "resources": ["gpu0", "airllm_instance"]}
  ],
  "nodes": [
    {"id": "extract_facts", "uses": "extract_fast",  "depends_on": []},
    {"id": "analyze",       "uses": "deep_reasoner", "depends_on": ["extract_facts", "find_issues"]}
  ]
}
```

This is what the CLI and web clients render. It carries no branch or loop
information — the shape change driving the client migration.

**404** — unknown workflow name.

---

## `POST /v1/workflows/{name}/run`

Executes the workflow and returns when it completes (FR-042).

**Request**
```json
{"inputs": {"text": "…", "question": "What caused the outage?"}}
```

`inputs` keys must exactly match the workflow's `input_fields` — a
missing or undeclared field is rejected naming the field (FR-043).

**200**
```json
{
  "workflow_name": "document_qa",
  "output_node": "final",
  "final_output": "The outage was caused by …",
  "nodes": {
    "extract_facts": {
      "node_id": "extract_facts",
      "alias": "extract_fast",
      "provider": "ollama",
      "physical_model": "qwen3:8b",
      "output": "…",
      "resource_wait_ms": 2.1,
      "execution_ms": 1840.7
    },
    "analyze": {
      "node_id": "analyze",
      "alias": "deep_reasoner",
      "provider": "airllm",
      "physical_model": "Qwen/Qwen3-32B",
      "output": "…",
      "resource_wait_ms": 1902.4,
      "execution_ms": 471300.0
    }
  }
}
```

`resource_wait_ms` and `execution_ms` are separate on purpose (FR-026).
The example shows why: `analyze` waited 1.9s for `gpu0` while an Ollama
step finished. Folding the two together would hide the contention this
stage exists to manage.

**Error responses** use the existing `ErrorResponse` shape. The failure
category travels in its `code` field (`ErrorCode`, see data-model.md) —
no separate `category` field:

| Status | `code` | Cause |
|---|---|---|
| 400 | `VALIDATION` | Missing or undeclared input field |
| 400 | `INPUT_TOO_LARGE` | Input or rendered prompt over limit |
| 401 | — | Missing/invalid credential |
| 404 | `VALIDATION` | Unknown workflow |
| 429 | — | Rate limited |
| 500 | `CONFIGURATION` | Unknown provider; AirLLM identity mismatch |
| 502 | `PROVIDER_UNAVAILABLE` | Ollama unreachable |
| 503 | `BACKEND_UNAVAILABLE` | AirLLM not loaded on this host |
| 504 | `PROVIDER_TIMEOUT` | A step exceeded its `timeout_seconds` |

**Step failure body** — the failing step is always identified (FR-024,
SC-005):

```json
{
  "timestamp": "2026-08-27T14:03:11Z",
  "status": 504,
  "error": "Gateway Timeout",
  "message": "Node 'analyze' failed: model call exceeded 900s",
  "code": "PROVIDER_TIMEOUT",
  "request": "POST /v1/workflows/document_qa/run",
  "exceptionUID": "…",
  "details": {"node_id": "analyze", "alias": "deep_reasoner"}
}
```

No stack traces, secrets, filesystem paths, or raw model output appear in
any error body (FR-046).

A run interrupted by service shutdown fails visibly rather than hanging
(FR-047).

---

## Removed endpoints

| Was | Why |
|---|---|
| `POST /ask` | Replaced by `POST /v1/workflows/{name}/run`. Its prompt-plus-history request shape is superseded by typed `inputs` |
| `POST /ask/stream` | Node-completion SSE returns at Stage 2 as `GET /v1/runs/{id}/events`, against durable runs. Keeping it now would mean building it twice |
| `GET /pipelines`, `GET /pipelines/{name}` | Renamed to `/v1/workflows...` with the new detail shape |

These are breaking changes with no deprecation window — the schema
change makes the old request and response bodies unrepresentable, and
both clients are in this repo and migrate with the server.

---

## Stage 2 forward-compatibility

Nothing here should need renaming when durable runs arrive. Expected
additions, not replacements:

```
POST /v1/runs                    submit, return 202 + run_id
GET  /v1/runs/{run_id}           status and outputs
GET  /v1/runs/{run_id}/events    SSE progress
POST /v1/runs/{run_id}/cancel
POST /v1/runs/{run_id}/retry
```

`POST /v1/workflows/{name}/run` may then become a thin synchronous
wrapper over submit-and-await, or be retired in favor of the async path.
That decision belongs to Stage 2's spec.
