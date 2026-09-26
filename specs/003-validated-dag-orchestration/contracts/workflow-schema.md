# Contract: Workflow Definition Schema (version 1)

The YAML format for a trusted, server-side workflow definition. This
replaces the previous per-node `model:` schema entirely; the old format
is rejected as an unsupported version rather than dual-supported
(FR-007).

Unknown fields are rejected everywhere (`extra="forbid"`, FR-006). Files
are parsed with a safe loader that cannot construct arbitrary Python
objects (FR-001).

## Complete example

```yaml
version: 1
name: document_qa
description: Extract facts and issues in parallel, analyze, then write an answer.

max_parallel_nodes: 4

input_fields: [text, question]

resources:
  gpu0: 1
  ollama_server: 2
  airllm_instance: 1

models:
  extract_fast:
    provider: ollama
    model: qwen3:8b
    resources: [gpu0, ollama_server]
    temperature: 0.0
    max_new_tokens: 300
    keep_alive: 0
    timeout_seconds: 60

  deep_reasoner:
    provider: airllm
    model: Qwen/Qwen3-32B
    resources: [gpu0, airllm_instance]
    temperature: 0.2
    max_input_tokens: 3000
    max_new_tokens: 500
    timeout_seconds: 900

  writer:
    provider: ollama
    model: qwen3:8b
    resources: [gpu0, ollama_server]
    temperature: 0.3
    max_new_tokens: 500
    keep_alive: 0

nodes:
  - id: extract_facts
    uses: extract_fast
    depends_on: []
    prompt: |
      Extract the relevant facts from:
      {{ input.text }}

  - id: find_issues
    uses: extract_fast
    depends_on: []
    prompt: |
      List any problems or inconsistencies in:
      {{ input.text }}

  - id: analyze
    uses: deep_reasoner
    depends_on: [extract_facts, find_issues]
    prompt: |
      Facts:
      {{ nodes.extract_facts.output }}

      Issues:
      {{ nodes.find_issues.output }}

      Question:
      {{ input.question }}

  - id: final
    uses: writer
    depends_on: [analyze]
    prompt: |
      Write the final answer based on this analysis:
      {{ nodes.analyze.output }}

output: final
```

`extract_facts` and `find_issues` have no edge between them, so they run
concurrently — but both consume `gpu0`, whose capacity is 1, so in
practice they serialize on the accelerator while `max_parallel_nodes`
would otherwise allow both. Concurrency is the *minimum* of graph
freedom, declared parallelism, and resource capacity.

## Field reference

### Top level

| Field | Type | Required | Rules |
|---|---|---|---|
| `version` | int | yes | Must be `1` |
| `name` | string | yes | Must match the file stem |
| `description` | string | no | Default `""` |
| `max_parallel_nodes` | int | yes | `>= 1` |
| `input_fields` | list[string] | yes | Names callers must supply at run time |
| `resources` | map[string, int] | yes | Each capacity `>= 1`; each name must exist in server configuration |
| `models` | map[string, ModelAlias] | yes | At least one |
| `nodes` | list[NodeSpec] | yes | At least one |
| `output` | string | yes | Must name a defined node |

### `ModelAlias`

| Field | Type | Required | Rules |
|---|---|---|---|
| `provider` | `ollama` \| `airllm` | yes | Any other value rejected |
| `model` | string | yes | Physical model id — server-controlled |
| `resources` | list[string] | yes | Each must be declared in `resources` |
| `system` | string | no | Optional system instruction |
| `max_input_tokens` | int | no | `>= 1` |
| `max_new_tokens` | int | no | `>= 1`, default 512 |
| `temperature` | float | no | `0.0`–`2.0`, default 0.2 |
| `top_p` | float | no | `0.0`–`1.0` |
| `keep_alive` | string \| int | no | **Ollama only** — rejected on an `airllm` alias |
| `timeout_seconds` | float | no | `> 0`, default 60 |

An `airllm` alias's `model` must match the model this process actually
loaded, or every step using it fails with `CONFIGURATION` (FR-039).

### `NodeSpec`

| Field | Type | Required | Rules |
|---|---|---|---|
| `id` | string | yes | `^[A-Za-z_][A-Za-z0-9_]*$` |
| `uses` | string | yes | Must name a defined alias |
| `depends_on` | list[string] | no | Default `[]`; no self-reference, no duplicates, each must exist |
| `prompt` | string | yes | Restricted template — see below |

## Template contract

Exactly two substitutions are legal:

| Form | Resolves to |
|---|---|
| `{{ input.FIELD }}` | The caller-supplied value for `FIELD`, which must be declared in `input_fields` |
| `{{ nodes.STEP.output }}` | `STEP`'s output text; `STEP` **must** appear in this node's `depends_on` |

Everything else is rejected at load time — loops, filters, function
calls, arbitrary attribute traversal, `{% ... %}` statements,
`{# ... #}` comments, and malformed placeholders (FR-014).

Validation is an allowlist over the parsed template, so an unanticipated
construct is rejected by default rather than by enumeration.

Rendering is strict: a value that resolves to nothing is an error, never
an empty string (FR-017).

**The hidden-dependency rule (FR-015)** is the one most likely to
surprise. This is rejected:

```yaml
  - id: summarize
    uses: writer
    depends_on: []                        # <- declares nothing
    prompt: "{{ nodes.extract.output }}"  # <- but reads extract
```

> `node 'summarize' references 'extract' in its prompt but does not declare it in depends_on`

The reference is real work the scheduler cannot see; permitting it would
let a node read a value that has not been produced yet.

## Validation error catalog

Every rejection names the offending element (FR-011). Representative
messages:

| Condition | Message shape |
|---|---|
| Unsupported version | `unsupported workflow version 2 (this server supports version 1)` |
| Duplicate node id | `duplicate node id(s): analyze` |
| Unknown alias | `node 'analyze' uses undefined model alias 'deep_thinker'` |
| Unknown dependency | `node 'final' depends_on unknown node 'analyse'` |
| Self-dependency | `node 'final' cannot depend on itself` |
| Duplicate dependency | `node 'final' lists dependency 'analyze' more than once` |
| Cycle | `cycle detected in depends_on: a -> b -> c -> a` |
| Output missing | `output 'summary' is not a defined node id` |
| Unreachable node | `node 'orphan' cannot reach the output node 'final'` |
| Undeclared resource | `alias 'writer' requires undeclared resource 'gpu1'` |
| Capacity too low | `resource 'gpu0' must have capacity >= 1, got 0` |
| Hidden dependency | `node 'summarize' references 'extract' in its prompt but does not declare it in depends_on` |
| Forbidden construct | `node 'final': template uses a forbidden construct (for-loop); only {{ input.FIELD }} and {{ nodes.STEP.output }} are permitted` |
| Unknown input field | `node 'final' references input field 'topic', which is not declared in input_fields` |
| `keep_alive` on AirLLM | `alias 'deep_reasoner': 'keep_alive' is only valid for the ollama provider` |

All are raised before any model is contacted (FR-012).

## Migration from the previous schema

| Previously | Now |
|---|---|
| Per-node `model: {provider, model, temperature}` | A named entry in `models:`, referenced by `uses:` |
| `{{ input }}` | `{{ input.FIELD }}`, with `FIELD` in `input_fields` |
| `{{ step.output }}` | `{{ nodes.step.output }}` |
| `prompt_template:` | `prompt:` |
| `output_node:` (string or list) | `output:` (single string) |
| `execution: {model_timeout_seconds, max_retries, ...}` | Per-alias `timeout_seconds`; retries deferred to Stage 2 |
| `branches:` | **No equivalent** — Stage 4 `condition` nodes |
| `loops:` | **No equivalent at any planned stage** — see ROADMAP.md open question |
| `max_history_turns` / conversation history | Declare a `history` input field and template it explicitly |

`output` narrowing from a list to a single node is a direct consequence
of dropping branches: multiple output candidates existed only because a
branch meant just one of several terminal nodes would actually run.
Without conditional routing, every node runs, so exactly one output node
is well-defined.
