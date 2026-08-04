# LLM Pipeline CLI

A keyboard-driven TypeScript CLI for the FastAPI + LangGraph DAG pipeline server.

## Setup

Depends on `@llm-pipeline/client` (shared API types + fetch client, in
`../packages/client`) via an npm workspace — install from the **repo root**,
not from this directory:

```bash
cd ..            # repo root
npm install
cd cli
```

## Run

Make sure the pipeline server is running first (default: `http://localhost:8000`).

```bash
npm start
```

Point at a different server:

```bash
PIPELINE_BASE_URL=http://localhost:9000 npm start
```

If the server has `API_KEYS` configured (see the server README's Auth section),
set `PIPELINE_API_KEY` so requests aren't rejected with `401`:

```bash
PIPELINE_API_KEY=your-key npm start
```

## Usage

On startup, the CLI shows server info and picks up the server's configured
`default_pipeline_name`. Type a prompt and press Enter to run it through the
active pipeline. Prior turns in the session are sent as conversation context
automatically.

### Commands

| Command | Description |
|---|---|
| `/help` | show available commands |
| `/health` | show server info: pipelines directory, default pipeline, all available pipelines |
| `/pipelines` | list every pipeline the server can run |
| `/pipeline` | show the **active** pipeline's DAG — every node, its model, and its dependencies |
| `/use <name>` | switch to a different pipeline (confirms it exists first; clears conversation history since a different DAG likely has different context semantics) |
| `/verbose` | toggle showing every node's output vs. just the final answer |
| `/stream` | toggle streaming node-by-node progress as the pipeline runs, instead of waiting for the whole thing to finish (off by default) |
| `/reset` | clear conversation history without switching pipelines |
| `/exit` | quit (also works: Ctrl+C or Ctrl+D) |

### Example session

```
LLM Pipeline server
pipelines dir:        pipelines
default pipeline:     simple-local

Available pipelines (5)
  simple-local — Single-node, all-Ollama pipeline for quick local testing
  consensus-qa — Multi-provider consensus for factual Q&A
  code-review-pipeline — Plan, then implement + test in parallel, then review and merge
  iterative-refinement — Generate, critique, and loop back to revise up to 3 times
  support-router — Classify a support request, then route to a specialized responder

Using pipeline "simple-local" — switch with /use <name>

(simple-local) › /use consensus-qa
switched to pipeline "consensus-qa" — conversation history cleared

(consensus-qa) › What year did the Berlin Wall fall?

pipeline: consensus-qa   took: 4.2s
────────────────────────────────────────────────────────
Final answer
All three sources agree: the Berlin Wall fell on November 9, 1989.
```

### Loops in action

`iterative-refinement.yaml` shows how many times it looped back before
settling on a final answer:

```
(consensus-qa) › /use iterative-refinement
switched to pipeline "iterative-refinement" — conversation history cleared

(iterative-refinement) › Write a one-sentence pitch for a coffee shop

pipeline: iterative-refinement   took: 6.1s
────────────────────────────────────────────────────────
Final answer
A cozy neighborhood coffee shop pouring meticulously sourced single-origin
beans for people who want their morning ritual to actually taste like
something.
────────────────────────────────────────────────────────
Loop iterations
  revise_until_approved: 2 time(s)
```

### Branches in action

`support-router.yaml` routes to exactly one of three responders — `/verbose`
shows only the matching route ran, not all three:

```
(iterative-refinement) › /use support-router
switched to pipeline "support-router" — conversation history cleared

(support-router) › /verbose
verbose mode: on

(support-router) › I want a refund for my last order

pipeline: support-router   took: 3.1s
────────────────────────────────────────────────────────
Final answer
I'm sorry to hear that — I've started your refund request...
────────────────────────────────────────────────────────
Node outputs (2)

classify (ollama:llama3.2:3b, 0.6s)
  REFUND

refund_flow (ollama:llama3, 2.5s)  ← output node
  I'm sorry to hear that — I've started your refund request...
```

Notice `tech_support_flow` and `general_flow` never appear — only the route
that actually matched executed.

Toggle `/verbose` to see every node's individual output (useful for
`consensus-qa` to see what each of the three models actually answered before
reconciliation, or for `code-review-pipeline` to see the plan/implementation/
tests/review stages separately):

```
(consensus-qa) › /verbose
verbose mode: on

(consensus-qa) › What year did the Berlin Wall fall?

pipeline: consensus-qa   took: 4.4s
────────────────────────────────────────────────────────
Final answer
All three sources agree: the Berlin Wall fell on November 9, 1989.
────────────────────────────────────────────────────────
Node outputs (4)

answer_local (ollama:qwen3-coder:30b, 1.8s)
  The Berlin Wall fell in 1989.

answer_b (ollama:llama3, 2.1s)
  November 9, 1989.

answer_c (ollama:gemma3:12b, 2.3s)
  The Berlin Wall fell on November 9, 1989.

reconcile (ollama:llama3, 4.2s)  ← output node
  All three sources agree: the Berlin Wall fell on November 9, 1989.
```

Toggle `/stream` to see each node complete in real time as the pipeline
runs, instead of one spinner until everything finishes — the difference is
most visible on multi-node pipelines like `consensus-qa`, where you see
each of the three independent generators finish as they actually do,
rather than only once the slowest one completes:

```
(consensus-qa) › /stream
streaming mode: on

(consensus-qa) › What year did the Berlin Wall fall?

✓ answer_local (ollama:qwen3-coder:30b, 1.8s)
✓ answer_b (ollama:llama3, 2.1s)
✓ answer_c (ollama:gemma3:12b, 2.3s)
✓ reconcile (ollama:llama3, 4.2s)

Final answer
All three sources agree: the Berlin Wall fell on November 9, 1989.
(4.4s total)
```

`/stream` and `/verbose` combine: with both on, each node's output prints
immediately below its completion line rather than only in a final summary.
This is **node-level** progress, not token-level — each line appears when
that node finishes, not as the model streams individual words. See
`llm_pipeline/README.md`'s `POST /ask/stream` section for why (token-level
streaming would mean every provider adapter implementing it individually;
node-level works uniformly across all of them).

## Response fields

Every answer now reports:
- `pipeline_name` — which pipeline actually served this request
- `output_node` — which node's output became the final answer (for pipelines
  with branches, this is whichever candidate actually resolved — see the
  server README's notes on `output_node` as a list of candidates)
- `node_outputs` — every node that ran, keyed by node id, each with `model_name`
  (`provider:model`, e.g. `ollama:qwen3-coder:30b`), `output`, and `duration_ms`
- `loop_iterations` — for pipelines using loops, how many times each loop
  looped back before exiting (`{}` for pipelines with no loops)

This replaces the old fixed `category`/`router_model`/`winning_model`/`judge_model`/
`candidates`/`votes` shape from the pre-DAG design — there's no fixed set of
tiers anymore, since a pipeline's shape is whatever its YAML defines.

## Error handling

Every server error — 400/401/404/422/429/502/503, and even a genuine
unhandled 500 — comes back as one consistent structured object, not just a
bare string. When a request fails, the CLI prints the `message` plus a
`reference id` (the server's `exceptionUID`, same value as its logged
`X-Request-ID`) — include that id if you're reporting an issue, since it's
searchable directly in server logs.

## Known limitation: history isn't summarized

Conversation history is sent as raw prior turns, capped by the active
pipeline's `execution.max_history_turns` (defined per-pipeline in its YAML).
Use `/reset` to clear it, or switch pipelines with `/use` (which clears it
automatically).

## Build a standalone binary (optional)

```bash
npm run build
node dist/index.js
```

## Docker (optional — plain local install is usually better)

This is an interactive terminal REPL, which is a genuinely weaker fit for
Docker than the web client's static build — Docker exists to isolate
processes/services, not really to wrap something you want to type into
directly. Unlike a Python CLI, there's no system-dependency mess Docker
would be solving here; `npm install && npm start` already works anywhere
Node runs, with no `-it`/TTY/networking setup needed.

Still, if you have a specific reason (no Node on this machine, running from
CI, etc.):

```bash
docker build -t llm-pipeline-cli .
docker run -it --rm \
  -e PIPELINE_BASE_URL=http://host.docker.internal:8000 \
  llm-pipeline-cli
```

`-it` is required — without it, the interactive prompt won't work at all.
`host.docker.internal` reaches a pipeline server running on your host
machine; if it's a sibling container on the same `docker compose` network
instead, use that service's name (e.g. `http://pipeline-server:8000`) and
add `--network <project>_default` to the `docker run` command.
