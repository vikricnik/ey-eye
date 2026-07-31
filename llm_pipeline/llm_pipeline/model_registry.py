"""
Per-category model registry.

This is the single place to configure which models generate and validate answers
for each category, and how many. Mix providers freely — e.g. run an Ollama model
alongside GPT-4o and Claude for CODE, while GENERAL only uses local Ollama models.

Router and judge are single global models (routing/judging aren't category-specific
in this design), but nothing stops you from making JUDGE_SPECS a dict[Category, ModelSpec]
too, following the same pattern as GENERATOR_SPECS, if you want category-specific judges.
"""

from llm_pipeline.category import Category
from llm_pipeline.providers import ModelSpec, ProviderType

# --- Router & judge: single global model each ---
ROUTER_SPEC: ModelSpec = ModelSpec(ProviderType.OLLAMA, "llama3.2:3b", temperature=0)
JUDGE_SPEC: ModelSpec = ModelSpec(ProviderType.OLLAMA, "llama3", temperature=0)

# --- Generators: N+ models per category ---
GENERATOR_SPECS: dict[Category, list[ModelSpec]] = {
    Category.CODE: [
        ModelSpec(ProviderType.OLLAMA, "qwen3-coder:30b", temperature=0.2),
        ModelSpec(ProviderType.OLLAMA, "llama3", temperature=0.3),
        # Example of adding cloud providers once API keys are configured
        # (see .env.example — these read OPENAI_API_KEY / ANTHROPIC_API_KEY from env):
        # ModelSpec(ProviderType.OPENAI, "gpt-4o", temperature=0.2),
        # ModelSpec(ProviderType.ANTHROPIC, "claude-sonnet-4-5", temperature=0.2),
    ],
    Category.MATH: [
        ModelSpec(ProviderType.OLLAMA, "qwen3-coder:30b", temperature=0.1),
        ModelSpec(ProviderType.OLLAMA, "llama3", temperature=0.1),
    ],
    Category.GENERAL: [
        ModelSpec(ProviderType.OLLAMA, "llama3", temperature=0.3),
        ModelSpec(ProviderType.OLLAMA, "gemma3:12b", temperature=0.3),
    ],
    Category.CREATIVE: [
        ModelSpec(ProviderType.OLLAMA, "llama3", temperature=0.7),
        ModelSpec(ProviderType.OLLAMA, "gemma3:12b", temperature=0.8),
        # ModelSpec(ProviderType.GEMINI, "gemini-2.0-flash", temperature=0.8),
    ],
}

# --- Validators: N+ models per category ---
# When LLM_VALIDATION_MODE=single, only the FIRST entry per category is used.
# When LLM_VALIDATION_MODE=multiple, ALL entries per category vote.
VALIDATOR_SPECS: dict[Category, list[ModelSpec]] = {
    Category.CODE: [
        ModelSpec(ProviderType.OLLAMA, "llama3.2:3b", temperature=0),
        ModelSpec(ProviderType.OLLAMA, "gemma3:4b", temperature=0),
    ],
    Category.MATH: [
        ModelSpec(ProviderType.OLLAMA, "llama3.2:3b", temperature=0),
        ModelSpec(ProviderType.OLLAMA, "gemma3:4b", temperature=0),
    ],
    Category.GENERAL: [
        ModelSpec(ProviderType.OLLAMA, "llama3.2:3b", temperature=0),
    ],
    Category.CREATIVE: [
        ModelSpec(ProviderType.OLLAMA, "llama3.2:3b", temperature=0),
    ],
}


def all_configured_specs() -> list[ModelSpec]:
    """Every model referenced anywhere in this registry — handy for startup
    validation or for printing a 'models you need to pull' checklist."""
    specs: list[ModelSpec] = [ROUTER_SPEC, JUDGE_SPEC]
    for category_specs in GENERATOR_SPECS.values():
        specs.extend(category_specs)
    for category_specs in VALIDATOR_SPECS.values():
        specs.extend(category_specs)
    return specs
