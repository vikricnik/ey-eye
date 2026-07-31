# LLM Pipeline Monorepo

A multi-tier LLM orchestration system: requests are routed to a category, generated
by N+ models configured for that category (any mix of Ollama/OpenAI/Anthropic/Gemini),
validated by N+ validators, and judged to pick the best answer — all fully
configurable, with two clients (CLI + web) to interact with it.

```
llm-pipeline-monorepo/
├── llm_pipeline/   Python — FastAPI + LangGraph orchestration server
├── cli/             TypeScript — keyboard-driven terminal client
└── web/             TypeScript + Vite — browser client
```

## Architecture at a glance

```
                        ┌─────────────┐
   prompt + history ──▶ │   Route     │  classifies into a Category
                        └──────┬──────┘  (CODE / GENERAL / MATH / CREATIVE)
                               │
                               ▼
                  ┌─────────────────────────┐
                  │  Generate + Validate    │  N+ generator models run
                  │  (per category)         │  (parallel or sequential,
                  │                         │   optionally collaborative);
                  │                         │  each answer is validated by
                  │                         │  N+ validators (single or
                  │                         │  multiple w/ quorum)
                  └───────────┬─────────────┘
                              │
                              ▼
                        ┌───────────┐
                        │   Judge   │  picks the best candidate
                        └─────┬─────┘
                              │
                              ▼
                    final answer + which model
                    did routing/generating/
                    validating/judging
```

Every model (router, N generators, N validators, judge) can be a different provider —
Ollama running locally, OpenAI, Anthropic, or Google Gemini — configured per category
in `llm_pipeline/llm_pipeline/model_registry.py`.

## Quickstart

### 1. Start the pipeline server

```bash
cd llm_pipeline
poetry install
cp .env.example .env
ollama pull llama3.2:3b llama3 qwen3-coder:30b gemma3:12b gemma3:4b
poetry run uvicorn llm_pipeline.main:app --reload --port 8000
```

Verify it's up:
```bash
curl http://localhost:8000/health
```

### 2. Use the CLI

```bash
cd cli
npm install
npm start
```

### 3. Or use the web client

```bash
cd web
npm install
npm run dev
```

Open the printed URL (typically `http://localhost:5173`).

Full setup/configuration/deployment details for each component are in their own
READMEs: [`llm_pipeline/README.md`](llm_pipeline/README.md),
[`cli/README.md`](cli/README.md), [`web/README.md`](web/README.md). This file covers
the system as a whole.

## Configuring the pipeline

Two kinds of configuration, deliberately kept separate:

**Behavior toggles** — simple on/off switches, live in `.env` (copy from
`llm_pipeline/.env.example`):

| Variable | Values | Effect |
|---|---|---|
| `LLM_PIPELINE_MODE` | `parallel` \| `sequential` | How generators for a category run relative to each other |
| `LLM_GENERATION_COLLABORATION` | `independent` \| `collaborative` | Sequential generators refine each other's answers (requires `sequential`) |
| `LLM_VALIDATION_MODE` | `single` \| `multiple` | One validator vs. all configured validators voting |
| `LLM_VALIDATION_QUORUM` | `0.0`–`1.0` | Approval fraction needed in `multiple` mode |
| `LLM_VALIDATION_CONCURRENCY` | `sequential` \| `parallel` | How multiple validators run |
| `LLM_MAX_HISTORY_TURNS` | integer | Prior conversation turns folded into context (`0` disables) |
| `OLLAMA_BASE_URL` | URL | Where Ollama is running |
| `CORS_ALLOWED_ORIGINS` | comma-separated or `*` | Which browser origins may call the API (needed for the web client) |

**Model assignments** — which specific models (and providers) handle each category,
live in code at `llm_pipeline/llm_pipeline/model_registry.py`, since expressing
nested per-category model lists as environment variables gets unwieldy fast:

```python
GENERATOR_SPECS: dict[Category, list[ModelSpec]] = {
    Category.CODE: [
        ModelSpec(ProviderType.OLLAMA, "qwen3-coder:30b", temperature=0.2),
        ModelSpec(ProviderType.OPENAI, "gpt-4o", temperature=0.2),
        ModelSpec(ProviderType.ANTHROPIC, "claude-sonnet-4-5", temperature=0.2),
    ],
    Category.MATH: [...],
    Category.GENERAL: [...],
    Category.CREATIVE: [...],
}
```

Add a 5th category, add a 4th generator to CODE, or swap in a different provider —
all pure config changes in that one file, no graph or node code needs to change.

## Adding a new LLM provider

The pipeline talks to every backend through one Protocol:

```python
class LLMProvider(Protocol):
    async def generate(self, prompt: str) -> str: ...
```

To add a new provider (say, a different cloud API):
1. Add a value to `ProviderType` in `providers.py`.
2. Write an adapter class implementing `generate()`.
3. Add a branch in `get_provider()`'s factory.
4. Reference it from `model_registry.py`.

Nothing else in the pipeline needs to know it exists.

## Conversation history

Both clients maintain a session-local conversation history and send it with every
request; the server folds up to `LLM_MAX_HISTORY_TURNS` prior turns into context
before routing. This is currently **raw replay** (every prior prompt + final answer
sent as plain text on every request) — simple and accurate, but token cost grows with
conversation length. See `llm_pipeline/README.md` for notes on summarization as a
future improvement. Use `/reset` (CLI) or the "reset conversation" button (web) to
clear history at any point.

## Deployment notes

This is set up for local development (Ollama on localhost, `--reload` dev servers).
For anything beyond local use:

- **Pipeline server**: run behind a process manager (e.g. `systemd`, `supervisor`) or
  containerize it; drop `--reload`; set `CORS_ALLOWED_ORIGINS` to your actual client
  origin(s) instead of `*`.
- **Ollama**: if models run remotely, point `OLLAMA_BASE_URL` at that host; make sure
  `OLLAMA_MAX_LOADED_MODELS` (set in Ollama's own environment, not `.env`) matches how
  many models you expect running concurrently.
- **Cloud providers**: set `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY` in
  the pipeline server's environment if you add cloud models to `model_registry.py`.
- **CLI**: `npm run build && node dist/index.js`, or run via `npx tsx` directly.
- **Web**: `npm run build` produces static files in `web/dist/` — serve with any
  static host (nginx, S3+CloudFront, Vercel, etc.), setting `window.PIPELINE_BASE_URL`
  to point at your deployed server.

## Example: full end-to-end run

```bash
# Terminal 1 — server
cd llm_pipeline
poetry run uvicorn llm_pipeline.main:app --reload --port 8000

# Terminal 2 — CLI
cd cli
npm start
```

```
› Write a Python function that merges two sorted lists

category: CODE   winner: ollama:qwen3-coder:30b
router: ollama:llama3.2:3b   judge: ollama:llama3
────────────────────────────────────────────────────────
Final answer
def merge_sorted_lists(a: list[int], b: list[int]) -> list[int]:
    result = []
    i = j = 0
    while i < len(a) and j < len(b):
        if a[i] <= b[j]:
            result.append(a[i]); i += 1
        else:
            result.append(b[j]); j += 1
    result.extend(a[i:])
    result.extend(b[j:])
    return result

› now make it work with any iterable, not just lists
```

The second prompt has no explicit subject ("it") — the CLI sent the first turn as
context automatically, so the pipeline knows what's being modified.

## Async/await usage

Every I/O-bound operation across all three components uses `async`/`await`:

- **Pipeline**: every model call (`provider.generate()`), every FastAPI route handler,
  every node function, and the graph's `pipeline.ainvoke()` call.
- **CLI**: `readline`'s prompt loop, all `fetch` calls, and the entry point itself uses
  real top-level `await` (not a `.then()`/`.catch()` chain) since Node 22 + ESM support it.
- **Web**: all `fetch` calls; DOM event listeners are declared `async` directly rather
  than wrapped with `void someAsyncFn()` where the listener body itself does the
  awaiting; health polling uses a self-scheduling async loop (`await check(); await
  delay(...)`) instead of `setInterval`, so a slow health check can't cause overlapping
  concurrent requests to pile up.

A few things are intentionally **not** async, because there's no I/O or awaitable work
to wrap — forcing `async`/`await` onto them would be noise, not correctness:
- The CLI's terminal spinner and the web client's relay-track animation are pure
  `setInterval` frame tickers with nothing to await.
- Pure/sync helpers like `Category.from_str()`, `build_contextual_prompt()`, and
  `ModelSpec.identity` do no I/O.
- Provider adapter constructors (`OllamaProvider.__init__`, etc.) just build client
  objects — no network call happens until `.generate()` is actually awaited.

## Robustness: what's implemented, and further recommendations

### Implemented in this repo

- **Per-model timeouts** (`LLM_MODEL_TIMEOUT_SECONDS`) — no single model call can hang
  a request indefinitely; a hung model is treated as a failure and isolated.
- **Failure isolation at every tier** — one bad generator, validator, or even the
  router/judge failing doesn't crash the whole request; see
  [`llm_pipeline/README.md`](llm_pipeline/README.md#failure-isolation--graceful-degradation)
  for the full behavior table. Covered by `tests/test_graceful_degradation.py`.
- **Distinct error surfaces** — `PipelineExecutionError` (a whole tier failed, `503`)
  is now separate from generic unexpected errors (`502`), so clients can tell "every
  model for this category is down" apart from "something else broke."
- **CORS**, **mypy --strict**, **typed responses end-to-end** (Python ↔ CLI ↔ web all
  share the same response shape).

### Recommended next steps (not yet implemented — roughly in priority order)

1. **Retries with backoff.** Timeouts currently isolate a failure but don't retry it.
   A transient blip (Ollama briefly overloaded, a cloud API rate limit) will fail a
   model that would have succeeded a second later. Wrapping `generate_with_timeout`
   with something like [`tenacity`](https://github.com/jd/tenacity)
   (`@retry(stop=stop_after_attempt(2), wait=wait_exponential(...))`) would meaningfully
   cut failure rates for free.

2. **Startup model validation.** Right now a typo'd model name in `model_registry.py`
   only surfaces when a request hits that category. A startup check (ping each
   configured model once, log which ones are unreachable) would catch misconfiguration
   before it reaches a user.

3. **Structured logging + request correlation IDs.** Logs currently interleave across
   concurrent requests with no way to group "which log lines belong to this one
   `/ask` call." Adding a request ID (via `contextvars` or FastAPI middleware) and
   switching to structured (JSON) logs would make debugging production issues far
   easier, and sets you up for real tracing (OpenTelemetry) later.

4. **Rate limiting / backpressure.** Nothing currently stops a client from firing
   concurrent requests that each fan out to N models — on a single Ollama instance
   this can thrash memory (as discussed earlier for `OLLAMA_MAX_LOADED_MODELS`). A
   simple in-process semaphore limiting concurrent `/ask` calls, or a proper rate
   limiter (`slowapi`), would protect the server under load.

5. **Circuit breaker per model.** If a specific model has failed the last N calls in
   a row (e.g. an API key expired), retrying and timing out on every single request is
   wasted latency. A simple circuit breaker (skip a model for a cooldown period after
   repeated failures, log it clearly) would fail faster and cheaper.

6. **Prompt/input safety.** There's currently no length cap or sanitization on
   `prompt`/`history` beyond "not empty." Consider a max length, and think through
   whether user-supplied history could be used to inject instructions into the
   judge/validator prompts (since history text is concatenated directly into prompts
   sent to every tier).

7. **Conversation history summarization.** Already flagged in the pipeline README —
   raw replay doesn't scale. Worth prioritizing once conversations regularly exceed a
   handful of turns.

8. **Tests against the live graph, not just unit tests.** `test_graceful_degradation.py`
   tests `nodes.py` functions directly via dependency injection. An integration test
   using FastAPI's `TestClient`/`httpx.AsyncClient` against the compiled `pipeline`
   graph (with mocked providers) would catch wiring issues the unit tests can't see.

9. **Containerization + CI.** A `Dockerfile`/`docker-compose.yml` (pipeline + Ollama)
   would make deployment reproducible; a GitHub Actions workflow running
   `mypy`, `pytest`, and `tsc --noEmit` for both clients on every push would catch
   regressions automatically rather than relying on manual checks like the ones done
   while building this out.

10. **Observability on model performance.** Right now there's no record of which
    models are actually winning judge votes over time, average latency per model, or
    validation pass rates. Even simple counters (in-memory or a lightweight metrics
    store) would tell you whether a configured model is pulling its weight or should be
    swapped out.

## License

Use this however you like — no license restrictions imposed by this scaffold.
