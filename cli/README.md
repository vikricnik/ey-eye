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

Commands and messages can also be piped in — each line runs in order (lines
that arrive while an earlier one is still running wait their turn), and the
CLI exits when the input ends:

```bash
printf '/use consensus-qa\nWhen did the Berlin Wall fall?\n' | npm start
```

## Usage

On startup, the CLI shows server info (`GET /server-info`: the default
pipeline and whether editing is on) and the pipelines it can run, and picks
up the server's configured `default_pipeline_name`. Type a prompt and press Enter to run it through the
active pipeline. Prior turns in the session are sent as conversation context
automatically.

### Commands

| Command | Description |
|---|---|
| `/help` | show available commands |
| `/health` | show server info: default pipeline, whether editing is on (and if not, why), all available pipelines |
| `/pipeline` | show the **active** pipeline's DAG (the draft's, while editing) as a box-drawing diagram — every node with its model, plain `depends_on` edges, and branch/loop edges each rendered visually distinct and labeled (condition/"default" for branches, max iterations for loops) |
| `/pipeline list` | list every pipeline the server can run |
| `/pipeline rm <name>` | delete a pipeline — the file moves to `pipelines/.deleted/` (recoverable); the server's default pipeline can't be deleted |
| `/use <name>` | switch to a different pipeline (confirms it exists first; clears conversation history since a different DAG likely has different context semantics) |
| `/verbose` | toggle showing every node's output vs. just the final answer |
| `/stream` | toggle streaming node-by-node progress as the pipeline runs, instead of waiting for the whole thing to finish (off by default). When on, the pipeline's diagram (same one `/pipeline` shows) redraws in place with live per-node status — ◐ marks a node the server reports as running right now — plus the branch route actually taken and loop iteration counts |
| `/reset` | clear conversation history without switching pipelines |
| `/rerun <node>` | run the last message again from `<node>`: it and every node after it call their models, the ones before reuse their outputs; the new answer replaces the last one in the conversation |
| `/preview <node> [message]` | what `<node>` would receive — for `[message]`, or else the last message with the last run's outputs (your draft while editing; needs editing enabled on the server) |
| `/exit` | quit (also: Ctrl+D, or Ctrl+C at the prompt). **During a run, Ctrl+C stops the run** (and `/test run`, `/compare`) instead: the server stops the model calls, and after a stopped streamed run `/rerun <node>` continues from a node that finished |

### Editing pipelines

Needs `PIPELINE_EDITING_ENABLED=true` on the server to save (loading,
validating and exporting work either way). Edits happen in a local draft —
the prompt shows `(name ✎*)` while it has unsaved changes — and the server
validates it on `/validate` and `/save`. Runs always use the saved version.

| Command | Description |
|---|---|
| `/edit [name]` | load a pipeline (default: the active one) into a draft |
| `/new <name> [--from <preset>]` | start a new one-node pipeline draft — a blank node, or one made from a preset |
| `/node` | table of the draft's nodes: model, temperature, dependencies, ★ output |
| `/node <id>` | one node's full configuration, including options, prompts, and the model's limits (max context, size) |
| `/node add <id> [--after a,b] [--model provider:model] [--from <preset>]` | add a node (blank, or from a preset) |
| `/dup <node> [new-id]` | duplicate a node: same settings and inputs, runs beside the original |
| `/node rm <id>` | remove a node and every edge/route/loop touching it |
| `/set <node>.<field> <value>` | change a node setting — see below |
| `/settings` | show the pipeline-wide settings: execution, history, defaults |
| `/settings set <setting> <value>` | change one — `description`, `execution.<…>` (incl. `max_concurrency`), `history.<max_turns\|intro\|turn_template\|max_chars\|remember\|summarize.model\|summarize.prompt>`, `defaults.<model\|temperature\|system_prompt\|strip_reasoning\|options.*>`; `unset` clears |
| `/prompt <node> [system]` | edit the prompt template (or system prompt) in `$EDITOR`; without one, type lines and finish with a single `.` |
| `/connect <from> <to>` / `/disconnect <from> <to>` | add/remove a dependency edge |
| `/output <node>[,<node>…]` | set the output node(s) |
| `/models` | the models this server lets you select |
| `/validate` | check the draft on the server (also lists models a save would reject, and settings beyond a model's limits) |
| `/save [name]` | save; a new name saves a copy. Comments and layout in the file are kept |
| `/discard` | drop the draft |
| `/preset` | list presets — a node's whole configuration, saved on the server and reusable in any pipeline |
| `/preset save <node> [name] [--description text…]` | save everything a node runs with (model, options, prompts, history and reasoning settings) as a preset; asks before replacing |
| `/preset show <name>` | a preset's full configuration |
| `/preset add <name> [--id x] [--after a,b]` | add a node made from it to the draft; its prompt's node references are fitted to its inputs |
| `/preset apply <name> <node>` | give an existing node a preset's configuration (id and inputs stay) |
| `/preset rm <name>` | remove a preset (recoverable; pipelines keep their copies) |
| `/test` | the test cases of the draft (or the active pipeline) |
| `/test run [case]` | run all cases, or one — the draft as it is, no save needed — and print pass/fail per case with time and tokens, then totals |
| `/test add` | add a case: its name, the message, then what the answer must satisfy, one per line: `contains: …`, `not: …`, `check: <condition on output>`, `judge: …` |
| `/test rm <case>` / `/test judge <model\|unset>` | remove a case / set the model that grades `judge` expectations |
| `/compare <node> <model> [<model>…]` | run every case as the pipeline is, and again with each model for `<node>`; shows each answer and per-model totals |
| `/import <file.yaml>` / `/export <file.yaml>` | load a YAML file into a draft / write the draft (or active pipeline) as canonical YAML |

`/set` fields: `model` (e.g. `ollama:gemma3:12b` — a bare name means
Ollama; `default` inherits the pipeline's default model), `temperature`,
`system`, `prompt`, `deps` (comma-separated), `id` (renames everywhere),
`history` (`on`/`off` — whether the node sees the conversation),
`reasoning` (`on`/`off`/`inherit` — strip `<think>` blocks), and `options.<name>` for any Ollama option —
`num_ctx`, `num_predict`, `top_p`, `top_k`, `repeat_penalty`,
`repeat_last_n`, `seed`, `stop` (comma-separated), `mirostat`,
`mirostat_eta`, `mirostat_tau`, `tfs_z`, `num_gpu`, `num_thread`,
`keep_alive`, `format`. `unset` clears a field.

```
(consensus-qa) › /edit
(consensus-qa ✎) › /set reconcile.temperature 0.3
(consensus-qa ✎*) › /set reconcile.options.num_ctx 8192
(consensus-qa ✎*) › /prompt reconcile system
(consensus-qa ✎*) › /save
```

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

While a node runs, a `▸ node: …` line under the diagram shows the newest
text its model is writing, token by token (parallel nodes each get a
line). `/stream` and `/verbose` combine: with both on, each node's full
output prints above the diagram the moment it completes.

## Response fields

Every answer now reports:
- `pipeline_name` — which pipeline actually served this request
- `output_node` — which node's output became the final answer (for pipelines
  with branches, this is whichever candidate actually resolved — see the
  server README's notes on `output_nodes` as a list of candidates)
- `node_outputs` — every node that ran, keyed by node id, each with `model_name`
  (`provider:model`, e.g. `ollama:qwen3-coder:30b`), `output`, `duration_ms`,
  and `usage` — shown in `/verbose` output as "3,900 in · 120 out · 42 tok/s ·
  context 4,096 (95% used)". A node whose prompt filled its context window
  gets a ⚠ warning after the answer even without `/verbose`: Ollama silently
  drops the start of a longer prompt.
- `loop_iterations` — for pipelines using loops, how many times each loop
  looped back before exiting (`{}` for pipelines with no loops)

This replaces the old fixed `category`/`router_model`/`winning_model`/`judge_model`/
`candidates`/`votes` shape from the pre-DAG design — there's no fixed set of
tiers anymore, since a pipeline's shape is whatever its YAML defines.

## Error handling

Every server error — 400/401/403/404/409/412/422/428/429/502, and even a genuine
unhandled 500 — comes back as one consistent structured object, not just a
bare string. When a request fails, the CLI prints the `message` plus a
`reference id` (the server's `request_id`, same value as its logged
`X-Request-ID`) — include that id if you're reporting an issue, since it's
searchable directly in server logs.

## Conversation history

Earlier turns (with any remembered node outputs) are sent with every message;
how many are kept, the character budget and whether older turns are
summarized are per-pipeline settings (`/settings`, `/settings set history.…`). Use
`/reset` to clear it, or switch pipelines with `/use` (which clears it
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
# from the repo root — the image needs the shared packages/client workspace
docker build -f cli/Dockerfile -t llm-pipeline-cli .
docker run -it --rm \
  -e PIPELINE_BASE_URL=http://host.docker.internal:8000 \
  llm-pipeline-cli
```

`-it` is required — without it, the interactive prompt won't work at all.
`host.docker.internal` reaches a pipeline server running on your host
machine; if it's a sibling container on the same `docker compose` network
instead, use that service's name (e.g. `http://pipeline-server:8000`) and
add `--network <project>_default` to the `docker run` command.
