import pytest

import llm_pipeline.nodes as nodes_module
from llm_pipeline.category import Category
from llm_pipeline.providers import ModelSpec, ProviderType
from llm_pipeline.errors import PipelineExecutionError


class _FailingProvider:
    async def generate(self, prompt: str) -> str:
        raise RuntimeError("simulated provider failure")


class _AlwaysValidProvider:
    async def generate(self, prompt: str) -> str:
        return "VALID"


class _AlwaysAnswersProvider:
    async def generate(self, prompt: str) -> str:
        return "a fine answer"


@pytest.mark.asyncio
async def test_run_validation_skips_failed_validators(monkeypatch: pytest.MonkeyPatch) -> None:
    """One bad validator should be dropped from the vote, not crash validation."""
    specs = [
        ModelSpec(ProviderType.OLLAMA, "good-model"),
        ModelSpec(ProviderType.OLLAMA, "bad-model"),
    ]
    monkeypatch.setitem(nodes_module.VALIDATOR_SPECS, Category.GENERAL, specs)

    def fake_get_provider(spec: ModelSpec) -> object:
        return _FailingProvider() if spec.model == "bad-model" else _AlwaysValidProvider()

    monkeypatch.setattr(nodes_module, "get_provider", fake_get_provider)

    is_valid, feedback, votes = await nodes_module._run_validation(
        Category.GENERAL, "question", "answer"
    )

    assert len(votes) == 1  # the failing validator's vote was dropped, not raised
    assert votes[0]["validator_name"] == "ollama:good-model"
    assert is_valid is True
    assert feedback is None


@pytest.mark.asyncio
async def test_run_validation_all_validators_failing_marks_invalid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If every validator fails, the answer is conservatively marked invalid
    rather than crashing or silently approving it."""
    specs = [ModelSpec(ProviderType.OLLAMA, "bad-model")]
    monkeypatch.setitem(nodes_module.VALIDATOR_SPECS, Category.GENERAL, specs)
    monkeypatch.setattr(nodes_module, "get_provider", lambda spec: _FailingProvider())

    is_valid, feedback, votes = await nodes_module._run_validation(
        Category.GENERAL, "question", "answer"
    )

    assert votes == []
    assert is_valid is False
    assert feedback is not None and "failed to respond" in feedback


@pytest.mark.asyncio
async def test_generate_and_validate_node_isolates_one_failing_generator(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One failing generator shouldn't take down the whole candidate pool."""
    generator_specs = [
        ModelSpec(ProviderType.OLLAMA, "good-gen"),
        ModelSpec(ProviderType.OLLAMA, "bad-gen"),
    ]
    validator_specs = [ModelSpec(ProviderType.OLLAMA, "good-validator")]

    monkeypatch.setitem(nodes_module.GENERATOR_SPECS, Category.GENERAL, generator_specs)
    monkeypatch.setitem(nodes_module.VALIDATOR_SPECS, Category.GENERAL, validator_specs)
    monkeypatch.setattr(nodes_module, "EXECUTION_MODE", "parallel")

    def fake_get_provider(spec: ModelSpec) -> object:
        if spec.model == "bad-gen":
            return _FailingProvider()
        if spec.model == "good-validator":
            return _AlwaysValidProvider()
        return _AlwaysAnswersProvider()

    monkeypatch.setattr(nodes_module, "get_provider", fake_get_provider)

    state = {
        "user_prompt": "q",
        "contextual_prompt": "q",
        "category": Category.GENERAL.value,
        "router_model": "ollama:router",
        "candidates": [],
        "final_answer": None,
        "winning_model": None,
        "judge_model": None,
    }

    result = await nodes_module.generate_and_validate_node(state)  # type: ignore[arg-type]

    assert len(result["candidates"]) == 1
    assert result["candidates"][0]["model_name"] == "ollama:good-gen"


@pytest.mark.asyncio
async def test_generate_and_validate_node_raises_when_all_generators_fail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If every generator for a category fails, raise a clear PipelineExecutionError
    rather than returning an empty candidate list for the judge to choke on."""
    generator_specs = [ModelSpec(ProviderType.OLLAMA, "bad-gen")]
    monkeypatch.setitem(nodes_module.GENERATOR_SPECS, Category.GENERAL, generator_specs)
    monkeypatch.setattr(nodes_module, "EXECUTION_MODE", "parallel")
    monkeypatch.setattr(nodes_module, "get_provider", lambda spec: _FailingProvider())

    state = {
        "user_prompt": "q",
        "contextual_prompt": "q",
        "category": Category.GENERAL.value,
        "router_model": "ollama:router",
        "candidates": [],
        "final_answer": None,
        "winning_model": None,
        "judge_model": None,
    }

    with pytest.raises(PipelineExecutionError):
        await nodes_module.generate_and_validate_node(state)  # type: ignore[arg-type]
