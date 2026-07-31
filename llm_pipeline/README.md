# llm_pipeline — FastAPI + LangGraph + multi-provider LLM orchestration

Multi-tier LLM pipeline: **route → generate (N models/category) → validate → judge**,
with any model from any provider (Ollama, OpenAI, Anthropic, Gemini, ...) pluggable
per category. See the repo root `README.md` for the full system overview; this file
covers just this component.

## Architecture

```
category.py        Category enum (CODE, GENERAL, MATH, CREATIVE)
providers.py        LLMProvider Protocol + adapters (Ollama/OpenAI/Anthropic/Gemini/Copilot*)
model_registry.py   Per-category model assignments (N+ generators, N+ validators each)
config.py           Behavior toggles (execution mode, validation mode, quorum, history window)
settings.py          Pydantic Settings — loads .env
models.py            Pydantic API schemas + LangGraph state
nodes.py             Tier logic: route / generate+validate / judge
graph.py             3-node LangGraph wiring: route -> generate_and_validate -> judge
main.py              FastAPI app: /health, /ask

* Copilot adapter is a placeholder — see providers.py docstring.
```

### Why one "generate_and_validate" node instead of one node per model?

Earlier versions of this pipeline had one static graph node per generator model.
That breaks once the *set* of generators depends on the request's category (CODE
might use 3 models, CREATIVE might use 2) — a LangGraph graph's shape is fixed at
compile time, but the category is only known after routing, at runtime.

Instead, a single `generate_and_validate_node` looks up `GENERATOR_SPECS[category]`
at runtime and fans out internally — via `asyncio.gather` in parallel mode, or a
plain loop (optionally collaborative) in sequential mode. This makes adding a
5th category or changing how many models any category uses a pure config change
in `model_registry.py`, with zero graph changes.

### Adding a new provider (e.g. a new cloud LLM)

1. Add a value to `ProviderType` in `providers.py`.
2. Write an adapter class with `async def generate(self, prompt: str) -> str`.
3. Add a branch for it in `get_provider()`'s factory.
4. Reference it in `model_registry.py`: `ModelSpec(ProviderType.YOUR_NEW_ONE, "model-id")`.

Nothing in `nodes.py` needs to change — it only ever calls `provider.generate(prompt)`
through the `LLMProvider` Protocol, regardless of backend.

### Configuring per-category models

Edit `llm_pipeline/model_registry.py` directly (it's plain Python, so it's type-checked
and IDE-autocompletable, unlike trying to express nested per-category model lists as
environment variables):

```python
GENERATOR_SPECS: dict[Category, list[ModelSpec]] = {
    Category.CODE: [
        ModelSpec(ProviderType.OLLAMA, "qwen3-coder:30b", temperature=0.2),
        ModelSpec(ProviderType.OPENAI, "gpt-4o", temperature=0.2),
        ModelSpec(ProviderType.ANTHROPIC, "claude-sonnet-4-5", temperature=0.2),
    ],
    # ...
}
```

Any category can have any number of generators/validators, mixing providers freely.

## Requirements

- Python 3.11+
- [Poetry](https://python-poetry.org/)
- [Ollama](https://ollama.com/) running locally, if using Ollama models (default registry uses only Ollama)
- API keys for any cloud providers you add to `model_registry.py` (see `.env.example`)

## Setup

```bash
poetry install
cp .env.example .env
```

To use cloud providers, also install their extras:

```bash
poetry install --extras openai       # for OpenAI/GPT models
poetry install --extras anthropic    # for Claude models
poetry install --extras gemini       # for Google Gemini models
poetry install --extras all-providers  # all three
```

Pull the Ollama models referenced in the default `model_registry.py`:

```bash
ollama pull llama3.2:3b
ollama pull llama3
ollama pull qwen3-coder:30b
ollama pull gemma3:12b
ollama pull gemma3:4b
```

## Run

```bash
poetry run uvicorn llm_pipeline.main:app --reload --port 8000
```

Check it's up — this also shows the full per-category model configuration currently active:

```bash
curl http://localhost:8000/health
```

## Configuration reference

Behavior toggles (`.env`, see `.env.example` for the full annotated list):

| Variable | Values | Effect |
|---|---|---|
| `LLM_PIPELINE_MODE` | `parallel` \| `sequential` | How generators for a category run relative to each other |
| `LLM_GENERATION_COLLABORATION` | `independent` \| `collaborative` | Whether sequential generators refine each other's answers (requires `sequential`) |
| `LLM_VALIDATION_MODE` | `single` \| `multiple` | Use only the first configured validator per category, or all of them |
| `LLM_VALIDATION_QUORUM` | `0.0`–`1.0` | Approval fraction needed when `multiple` (0.5 = majority, 1.0 = unanimous) |
| `LLM_VALIDATION_CONCURRENCY` | `sequential` \| `parallel` | How multiple validators run |
| `LLM_MAX_HISTORY_TURNS` | integer | Prior turns folded into context (`0` disables history) |
| `LLM_MODEL_TIMEOUT_SECONDS` | float | Hard per-model-call timeout; a hung model is treated as failed, not blocking |
| `OLLAMA_BASE_URL` | URL | Where Ollama is running |
| `CORS_ALLOWED_ORIGINS` | comma-separated or `*` | Which browser origins may call this API |

Model assignments (`llm_pipeline/model_registry.py`, not env vars):

- `ROUTER_SPEC` / `JUDGE_SPEC` — single global models
- `GENERATOR_SPECS[category]` — list of `ModelSpec`, any length, any provider mix
- `VALIDATOR_SPECS[category]` — list of `ModelSpec`, any length, any provider mix

### Example configurations

**Fast, low-RAM, all-local:**
```bash
LLM_PIPELINE_MODE=sequential
LLM_VALIDATION_MODE=single
```

**Best quality, multi-model consensus (needs more RAM/API budget):**
```bash
LLM_PIPELINE_MODE=parallel
LLM_VALIDATION_MODE=multiple
LLM_VALIDATION_QUORUM=0.5
LLM_VALIDATION_CONCURRENCY=parallel
```

**Relay/refinement chain — each model improves the last:**
```bash
LLM_PIPELINE_MODE=sequential
LLM_GENERATION_COLLABORATION=collaborative
```

Pair with Ollama server env vars (set **before** `ollama serve`, not in this `.env`):
```bash
export OLLAMA_MAX_LOADED_MODELS=3   # match to how many Ollama models run concurrently
export OLLAMA_KEEP_ALIVE=30m
```

## API

### `GET /health`
```json
{
  "status": "ok",
  "execution_mode": "parallel",
  "generation_collaboration": "independent",
  "validation_mode": "single",
  "validation_quorum": 0.5,
  "validation_concurrency": "sequential",
  "max_history_turns": 6,
  "router_model": "ollama:llama3.2:3b",
  "judge_model": "ollama:llama3",
  "generators_by_category": {
    "CODE": ["ollama:qwen3-coder:30b", "ollama:llama3"],
    "GENERAL": ["ollama:llama3", "ollama:gemma3:12b"],
    "MATH": ["ollama:qwen3-coder:30b", "ollama:llama3"],
    "CREATIVE": ["ollama:llama3", "ollama:gemma3:12b"]
  },
  "validators_by_category": {
    "CODE": ["ollama:llama3.2:3b", "ollama:gemma3:4b"],
    "GENERAL": ["ollama:llama3.2:3b"],
    "MATH": ["ollama:llama3.2:3b", "ollama:gemma3:4b"],
    "CREATIVE": ["ollama:llama3.2:3b"]
  }
}
```

### `POST /ask`

Request:
```json
{
  "prompt": "Write a Kotlin function that checks if a string is a palindrome",
  "history": [
    { "prompt": "What language should I use for Android?", "final_answer": "Kotlin is the modern standard for Android development." }
  ]
}
```
`history` is optional — omit it or send `[]` for a stateless single-turn request.

Response — every tier's responsible model is now identified explicitly:
```json
{
  "category": "CODE",
  "final_answer": "fun isPalindrome(s: String): Boolean { ... }",
  "winning_model": "ollama:qwen3-coder:30b",
  "router_model": "ollama:llama3.2:3b",
  "judge_model": "ollama:llama3",
  "candidates": [
    {
      "model_name": "ollama:qwen3-coder:30b",
      "answer": "...",
      "is_valid": true,
      "feedback": null,
      "votes": [
        { "validator_name": "ollama:llama3.2:3b", "is_valid": true, "feedback": null }
      ]
    },
    {
      "model_name": "ollama:llama3",
      "answer": "...",
      "is_valid": true,
      "feedback": null,
      "votes": [
        { "validator_name": "ollama:llama3.2:3b", "is_valid": true, "feedback": null }
      ]
    }
  ]
}
```
`votes` has one entry per validator that ran — one entry in `single` mode, N entries
in `multiple` mode.

## Failure isolation & graceful degradation

Every model call (router, each generator, each validator, judge) is wrapped with a
hard timeout (`LLM_MODEL_TIMEOUT_SECONDS`) and normalized into a single `ProviderError`
type, regardless of which provider/SDK actually failed. This means one bad model
doesn't take the whole request down:

| Tier | If it fails | Behavior |
|---|---|---|
| Router | times out / errors | Falls back to `Category.GENERAL`, request proceeds |
| One generator (of N) | times out / errors | Dropped from the candidate pool; the rest still run |
| **All** generators for a category | all fail | Raises `PipelineExecutionError` → API returns `503` with a clear message |
| One validator (of N) | times out / errors | Dropped from that answer's vote; quorum computed over the rest |
| **All** validators for an answer | all fail | Answer is conservatively marked `is_valid: false` (not silently approved) |
| Judge | times out / unparseable | Falls back to the first valid candidate rather than discarding all answers |

This is covered by `tests/test_graceful_degradation.py`, which simulates failing
providers via dependency injection (monkeypatching `get_provider`) without needing a
live Ollama instance or network access.

## Development

Type-check:
```bash
poetry run mypy llm_pipeline/
```

Run tests:
```bash
poetry run pytest
```

## Notes on conversation history

History is implemented as **raw replay**: every prior turn's prompt + final answer is
concatenated as plain text and re-sent to every tier (router, each generator, each
validator, judge) on every request. Simple and accurate, but doesn't scale — token cost
and latency grow linearly with conversation length, multiplied by however many models
are in the pipeline for the resolved category.

For longer-running conversations, consider **summarization**: periodically compress
older turns via a cheap model instead of replaying them verbatim, keeping the context
window bounded regardless of conversation length. Not implemented here —
`LLM_MAX_HISTORY_TURNS` provides a simple cap in the meantime by dropping turns older
than the window.
