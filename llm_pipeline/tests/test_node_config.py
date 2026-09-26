"""Per-node configuration: Ollama options, system prompt, editor layout,
and how they reach the provider layer."""

from typing import Any, ClassVar

import pytest
from pydantic import ValidationError

from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.providers import ModelSpec, OllamaOptions, ProviderType, Usage
from llm_pipeline.providers.ollama import OllamaProvider


def _definition(node_overrides: dict[str, Any]) -> dict[str, Any]:
    node: dict[str, Any] = {
        "id": "a",
        "model": {"provider": "ollama", "model": "llama3"},
        "prompt_template": "{{ input }}",
    }
    node.update(node_overrides)
    return {"name": "p", "nodes": [node], "output_node": "a"}


def test_ollama_options_system_prompt_and_layout_are_accepted() -> None:
    definition = PipelineDefinition.model_validate(
        _definition(
            {
                "model": {
                    "provider": "ollama",
                    "model": "llama3",
                    "temperature": 0.7,
                    "options": {
                        "top_p": 0.9,
                        "top_k": 40,
                        "num_ctx": 8192,
                        "num_predict": 256,
                        "repeat_penalty": 1.1,
                        "seed": 7,
                        "stop": ["###"],
                        "mirostat": 2,
                        "keep_alive": "5m",
                        "format": "json",
                    },
                },
                "system_prompt": "Be terse.",
                "layout": {"x": 10, "y": 20.5},
            }
        )
    )
    node = definition.nodes[0]
    assert node.model is not None and node.model.options is not None
    assert node.model.options.num_ctx == 8192
    assert node.model.options.stop == ("###",)
    assert node.system_prompt == "Be terse."
    assert node.layout is not None and node.layout.y == 20.5


def test_options_are_rejected_for_non_ollama_providers() -> None:
    with pytest.raises(ValidationError, match="only supported for provider 'ollama'"):
        PipelineDefinition.model_validate(
            _definition(
                {"model": {"provider": "openai", "model": "gpt-4o", "options": {"top_k": 5}}}
            )
        )


@pytest.mark.parametrize(
    "overrides",
    [
        {"temprature": 0.3},  # typo'd node field
        {"model": {"provider": "ollama", "model": "llama3", "temprature": 0.3}},
        {"model": {"provider": "ollama", "model": "llama3", "options": {"num_ctxx": 1}}},
        {"layout": {"x": 1, "y": 2, "z": 3}},
    ],
)
def test_unknown_fields_are_rejected_not_ignored(overrides: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        PipelineDefinition.model_validate(_definition(overrides))


@pytest.mark.parametrize(
    "model_block",
    [
        {"provider": "ollama", "model": "llama3", "temperature": 2.5},
        {"provider": "ollama", "model": "llama3", "temperature": -0.1},
        {"provider": "ollama", "model": "llama3", "options": {"top_p": 1.5}},
        {"provider": "ollama", "model": "llama3", "options": {"num_ctx": 0}},
        {"provider": "ollama", "model": "llama3", "options": {"mirostat": 3}},
        {"provider": "ollama", "model": ""},
    ],
)
def test_out_of_range_values_are_rejected(model_block: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        PipelineDefinition.model_validate(_definition({"model": model_block}))


def test_cache_key_distinguishes_options() -> None:
    plain = ModelSpec(ProviderType.OLLAMA, "llama3", 0.2)
    with_ctx = ModelSpec(ProviderType.OLLAMA, "llama3", 0.2, OllamaOptions(num_ctx=4096))
    other_ctx = ModelSpec(ProviderType.OLLAMA, "llama3", 0.2, OllamaOptions(num_ctx=8192))
    assert len({plain.cache_key, with_ctx.cache_key, other_ctx.cache_key}) == 3
    assert with_ctx.identity == plain.identity == "ollama:llama3"


class _RecordingChatOllama:
    last_kwargs: ClassVar[dict[str, Any]] = {}
    last_messages: ClassVar[object] = None

    def __init__(self, **kwargs: Any) -> None:
        _RecordingChatOllama.last_kwargs = kwargs

    async def ainvoke(self, messages: object) -> Any:
        _RecordingChatOllama.last_messages = messages

        class _Result:
            content = "answer"
            # What ChatOllama reports: LangChain's normalized counts, and
            # Ollama's own timings (nanoseconds).
            usage_metadata: ClassVar[dict[str, int]] = {
                "input_tokens": 31,
                "output_tokens": 4,
                "total_tokens": 35,
            }
            response_metadata: ClassVar[dict[str, object]] = {
                "eval_count": 4,
                "eval_duration": 80_000_000,
                "load_duration": 2_000_000_000,
            }

        return _Result()


@pytest.mark.asyncio
async def test_ollama_provider_passes_options_and_system_message(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import langchain_ollama

    monkeypatch.setattr(langchain_ollama, "ChatOllama", _RecordingChatOllama)

    spec = ModelSpec(
        ProviderType.OLLAMA,
        "llama3",
        0.4,
        OllamaOptions(num_ctx=8192, top_k=20, stop=("END",), keep_alive=0),
    )
    provider = OllamaProvider(spec)
    answer = await provider.generate("hi", system="Be terse.")

    assert answer.text == "answer"
    assert answer.usage == Usage(prompt_tokens=31, completion_tokens=4, generation_ms=80.0)
    kwargs = _RecordingChatOllama.last_kwargs
    assert kwargs["model"] == "llama3"
    assert kwargs["temperature"] == 0.4
    assert kwargs["num_ctx"] == 8192
    assert kwargs["top_k"] == 20
    assert kwargs["stop"] == ["END"]
    assert kwargs["keep_alive"] == 0
    assert "top_p" not in kwargs  # unset options fall back to the model's own defaults
    assert _RecordingChatOllama.last_messages == [("system", "Be terse."), ("human", "hi")]


@pytest.mark.asyncio
async def test_ollama_provider_without_system_sends_only_the_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import langchain_ollama

    monkeypatch.setattr(langchain_ollama, "ChatOllama", _RecordingChatOllama)

    await OllamaProvider(ModelSpec(ProviderType.OLLAMA, "llama3")).generate("hi")
    assert _RecordingChatOllama.last_messages == [("human", "hi")]
