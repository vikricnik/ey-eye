# LLM Pipeline CLI

A keyboard-driven TypeScript CLI for the FastAPI + LangGraph pipeline.

## Setup

```bash
npm install
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

## Usage

Type a prompt and press Enter. Prior turns in the session are automatically sent as
conversation context, so follow-ups like "make it faster" work without repeating
yourself.

### Commands

| Command | Description |
|---|---|
| `/help` | show available commands |
| `/health` | show current config: execution/validation modes, and every generator/validator model configured per category |
| `/verbose` | toggle showing all candidate answers + validator votes vs. just the final answer |
| `/reset` | clear conversation history and start fresh |
| `/exit` | quit (also works: Ctrl+C or Ctrl+D) |

### Example session

```
› Write a Kotlin function that checks if a string is a palindrome

category: CODE   winner: ollama:qwen3-coder:30b
router: ollama:llama3.2:3b   judge: ollama:llama3
────────────────────────────────────────────────────────
Final answer
fun isPalindrome(s: String): Boolean {
    val cleaned = s.filter { it.isLetterOrDigit() }.lowercase()
    return cleaned == cleaned.reversed()
}

› make it case-sensitive
```

The second prompt has no explicit subject — the server receives it along with the
first turn as context, so it knows "it" refers to the palindrome function.

Toggle `/verbose` to see every candidate model's answer, validation status, and
individual validator votes (populated when running in `multiple` validation mode).

## Response fields

Every answer now reports which model handled each pipeline tier:

- `router_model` — classified the request into a category
- `winning_model` — generated the answer the judge picked
- `judge_model` — picked the winner among candidates
- each candidate's `model_name` — which generator produced it
- each vote's `validator_name` — which validator approved/rejected it

Model identities are formatted as `provider:model`, e.g. `ollama:qwen3-coder:30b` or
`openai:gpt-4o`, so it's clear at a glance which provider handled which step —
useful once you configure a mix of Ollama/OpenAI/Anthropic/Gemini models per category
in the server's `model_registry.py`.

## Known limitation: history isn't summarized

Conversation history is sent as raw prior turns (prompt + final answer), capped by
the server's `LLM_MAX_HISTORY_TURNS` setting. For very long conversations this means
growing token cost per request — use `/reset` to clear it, or see the server README's
notes on summarization as a future improvement.

## Build a standalone binary (optional)

```bash
npm run build
node dist/index.js
```
