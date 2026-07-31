from llm_pipeline.category import Category
from llm_pipeline.providers import ModelSpec, ProviderType
from llm_pipeline.model_registry import all_configured_specs


def test_category_from_str_recognizes_valid_values() -> None:
    assert Category.from_str("CODE") == Category.CODE
    assert Category.from_str("code") == Category.CODE
    assert Category.from_str("  Math  ") == Category.MATH


def test_category_from_str_falls_back_to_general() -> None:
    assert Category.from_str("NONSENSE") == Category.GENERAL
    assert Category.from_str("") == Category.GENERAL


def test_model_spec_identity_format() -> None:
    spec = ModelSpec(ProviderType.OLLAMA, "qwen3-coder:30b", temperature=0.2)
    assert spec.identity == "ollama:qwen3-coder:30b"

    spec2 = ModelSpec(ProviderType.OPENAI, "gpt-4o")
    assert spec2.identity == "openai:gpt-4o"


def test_all_configured_specs_includes_router_and_judge() -> None:
    specs = all_configured_specs()
    identities = [s.identity for s in specs]
    assert "ollama:llama3.2:3b" in identities  # router
    assert "ollama:llama3" in identities  # judge / generators
