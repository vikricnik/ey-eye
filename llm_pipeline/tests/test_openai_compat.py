"""The OpenAI-compatible endpoints: pipelines as models, conversation
mapping, streaming, usage and error shapes."""

import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

import llm_pipeline.dag_builder.node_types as node_types_module
import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.main import app
from llm_pipeline.providers import Generation, ModelSpec, Usage
from llm_pipeline.routers.openai_compat import RETRY_NOTICE
from llm_pipeline.settings import settings

# The base URL an OpenAI client is configured with. Written out rather than
# imported: it is the public contract these tests pin down.
BASE = "/openai/v1"


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


def _chunks(text: str) -> list[Any]:
    """The `data:` payloads of an OpenAI-style stream, "[DONE]" as a string."""
    payloads: list[Any] = []
    for block in text.strip().split("\n\n"):
        assert block.startswith("data: "), block
        data = block[len("data: ") :]
        payloads.append(data if data == "[DONE]" else json.loads(data))
    return payloads


def _content(chunks: list[Any]) -> list[str]:
    return [
        c["choices"][0]["delta"]["content"]
        for c in chunks
        if isinstance(c, dict) and c.get("choices") and c["choices"][0]["delta"].get("content")
    ]


def test_pipelines_are_listed_as_models(client: TestClient) -> None:
    body = client.get(f"{BASE}/models").json()
    assert body["object"] == "list"
    assert {"simple-local", "consensus-qa", "iterative-refinement"} <= {
        m["id"] for m in body["data"]
    }


def test_a_conversation_runs_with_its_history_and_reports_summed_usage(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    prompts: list[str] = []

    class _Provider:
        async def generate(self, prompt: str, system: str | None = None) -> Generation:
            prompts.append(prompt)
            return Generation("6", Usage(prompt_tokens=40, completion_tokens=2))

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _Provider())
    response = client.post(
        f"{BASE}/chat/completions",
        json={
            "model": "simple-local",
            "temperature": 0.9,  # OpenAI parameters are accepted and ignored
            "messages": [
                {"role": "system", "content": "ignored — nodes have their own"},
                {"role": "user", "content": "2+2?"},
                {"role": "assistant", "content": "4"},
                {"role": "user", "content": [{"type": "text", "text": "and 3+3?"}]},
            ],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["object"] == "chat.completion" and body["model"] == "simple-local"
    assert body["choices"][0]["message"] == {"role": "assistant", "content": "6"}
    assert body["choices"][0]["finish_reason"] == "stop"
    assert body["usage"] == {"prompt_tokens": 40, "completion_tokens": 2, "total_tokens": 42}
    assert prompts == ["Conversation so far:\nUser: 2+2?\nAssistant: 4\n\nNew request: and 3+3?"]


class _StreamingProvider:
    """Backed by a (fake) LangChain chat model, so LangGraph sees its tokens."""

    def __init__(self, text: str) -> None:
        self.text = text

    async def generate(self, prompt: str, system: str | None = None) -> str:
        llm = GenericFakeChatModel(messages=iter([AIMessage(content=self.text)]))
        return str((await llm.ainvoke([("human", prompt)])).content)


def test_the_output_node_streams_live(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    def provider(spec: ModelSpec) -> _StreamingProvider:
        return _StreamingProvider(f"words from {spec.model} here")

    monkeypatch.setattr(node_types_module, "get_provider", provider)
    response = client.post(
        f"{BASE}/chat/completions",
        json={
            "model": "consensus-qa",
            "stream": True,
            "stream_options": {"include_usage": True},
            "messages": [{"role": "user", "content": "q"}],
        },
    )
    assert response.headers["content-type"].startswith("text/event-stream")
    chunks = _chunks(response.text)
    assert chunks[0]["choices"][0]["delta"] == {"role": "assistant", "content": ""}
    pieces = _content(chunks)
    assert len(pieces) > 1  # token by token, not one block
    # Only the output node's text — not the three answers it reconciles.
    assert "".join(pieces) == "words from llama3 here"
    assert chunks[-3]["choices"][0]["finish_reason"] == "stop"
    assert chunks[-2]["choices"] == [] and chunks[-2]["usage"]["total_tokens"] == 0
    assert chunks[-1] == "[DONE]"


def test_a_looping_pipeline_answers_in_one_piece(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def provider(spec: ModelSpec) -> _StreamingProvider:
        # iterative-refinement: generate (llama3) drafts, critique approves.
        return _StreamingProvider("APPROVE" if spec.model == "llama3.2:3b" else "final draft text")

    monkeypatch.setattr(node_types_module, "get_provider", provider)
    response = client.post(
        f"{BASE}/chat/completions",
        json={
            "model": "iterative-refinement",
            "stream": True,
            "messages": [{"role": "user", "content": "q"}],
        },
    )
    assert _content(_chunks(response.text)) == ["final draft text"]


def test_a_failure_while_streaming_is_an_error_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Down:
        async def generate(self, prompt: str, system: str | None = None) -> str:
            raise ConnectionError("ollama down")

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _Down())
    response = client.post(
        f"{BASE}/chat/completions",
        json={
            "model": "simple-local",
            "stream": True,
            "messages": [{"role": "user", "content": "q"}],
        },
    )
    chunks = _chunks(response.text)
    assert chunks[-1] == "[DONE]"
    error = chunks[-2]["error"]
    assert error["type"] == "server_error" and "ollama down" in error["message"]
    # The failed first attempt was followed by a retry; nothing had streamed
    # yet, so no retry notice was sent.
    assert RETRY_NOTICE not in "".join(_content(chunks))


def test_errors_use_openais_shape(client: TestClient) -> None:
    missing = client.post(
        f"{BASE}/chat/completions",
        json={"model": "no-such-pipeline", "messages": [{"role": "user", "content": "q"}]},
    )
    assert missing.status_code == 404
    assert missing.json()["error"]["type"] == "invalid_request_error"
    assert missing.json()["error"]["code"] == "pipeline_not_found"
    assert "no-such-pipeline" in missing.json()["error"]["message"]

    not_asked = client.post(
        f"{BASE}/chat/completions",
        json={"model": "simple-local", "messages": [{"role": "assistant", "content": "hi"}]},
    )
    assert not_asked.status_code == 400
    assert not_asked.json()["error"]["message"] == "the last message must be the user's"

    malformed = client.post(
        f"{BASE}/chat/completions", json={"model": "simple-local", "messages": []}
    )
    assert malformed.status_code == 422 and "error" in malformed.json()


def test_the_api_key_is_accepted_as_a_bearer_token(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "api_keys", "secret")
    assert client.get(f"{BASE}/models").status_code == 401
    assert client.get(f"{BASE}/models").json()["error"]["type"] == "authentication_error"
    ok = client.get(f"{BASE}/models", headers={"Authorization": "Bearer secret"})
    assert ok.status_code == 200


def test_a_rate_limited_request_keeps_retry_after_in_openais_shape(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1))
    client.get(f"{BASE}/models")
    limited = client.get(f"{BASE}/models")
    assert limited.status_code == 429
    assert limited.json()["error"]["type"] == "rate_limit_error"
    assert "Retry-After" in limited.headers


def test_v1_is_left_to_this_apis_own_versioning(client: TestClient) -> None:
    assert client.get("/v1/models").status_code == 404
    assert client.post("/v1/chat/completions", json={}).status_code == 404
