"""
What a node actually runs with, after pipeline defaults are applied — the
single place the inheritance rules live (see NodeDefaults' docstring), used
by the graph builder and by anything that needs a node's real model.
"""

from dataclasses import dataclass

from llm_pipeline.pipeline_config.schema import (
    DEFAULT_TEMPERATURE,
    NodeConfig,
    NodeModelConfig,
    PipelineDefinition,
)
from llm_pipeline.providers.base import OllamaOptions, ProviderType


@dataclass(frozen=True)
class EffectiveNode:
    model: NodeModelConfig  # temperature always set; options merged
    system_prompt: str | None
    strip_reasoning: bool
    include_history: bool


def effective_model(
    own: NodeModelConfig | None, default: NodeModelConfig | None
) -> NodeModelConfig | None:
    base = own or default
    if base is None:
        return None
    temperature = (
        base.temperature
        if base.temperature is not None
        else default.temperature
        if default is not None and default.temperature is not None
        else DEFAULT_TEMPERATURE
    )
    options = base.options
    if (
        own is not None
        and default is not None
        and own.provider == ProviderType.OLLAMA
        and default.provider == ProviderType.OLLAMA
        and default.options is not None
    ):
        merged = default.options.model_dump(exclude_none=True)
        if own.options is not None:
            merged.update(own.options.model_dump(exclude_none=True))
        options = OllamaOptions.model_validate(merged)
    return base.model_copy(update={"temperature": temperature, "options": options})


def effective_node(definition: PipelineDefinition, node: NodeConfig) -> EffectiveNode:
    model = effective_model(node.model, definition.defaults.model)
    if model is None:
        # validation.py guarantees every llm_call node resolves to a model.
        raise ValueError(f"node '{node.id}' has no model and the pipeline has no default model")
    return EffectiveNode(
        model=model,
        system_prompt=(
            node.system_prompt
            if node.system_prompt is not None
            else definition.defaults.system_prompt
        ),
        strip_reasoning=(
            node.strip_reasoning
            if node.strip_reasoning is not None
            else definition.defaults.strip_reasoning
        ),
        include_history=node.include_history,
    )
