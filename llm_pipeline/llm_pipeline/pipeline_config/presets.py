"""
Presets: one node's whole configuration (model, generation options,
prompts, history and reasoning settings) saved under a name, ready to add
to any pipeline.

Adding or applying a preset COPIES its values into the node; the pipeline
never references a preset by name. Editing or removing a preset therefore
never silently changes a pipeline that was saved earlier — what a pipeline
file says is exactly what runs.
"""

from pydantic import BaseModel, ConfigDict, Field, field_validator

from llm_pipeline.pipeline_config.schema import NodeModelConfig
from llm_pipeline.pipeline_config.templates import undeclared_variables


class NodePreset(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(pattern=r"^[a-zA-Z0-9_-]+$")
    description: str = ""
    model: NodeModelConfig
    system_prompt: str | None = None
    # Optional: older presets are "model + settings" only and leave the
    # node's own prompt untouched when applied.
    prompt_template: str | None = None
    # False: nodes made from this preset don't see the conversation. Unset
    # means the node default (they do); True is stored as unset.
    include_history: bool | None = None
    # Unset: nodes made from this preset follow the pipeline's default.
    strip_reasoning: bool | None = None

    @field_validator("prompt_template")
    @classmethod
    def _parses(cls, template: str | None) -> str | None:
        # Only syntax here: which node outputs a prompt may reference
        # depends on the pipeline it lands in, and that pipeline's own
        # validation checks it.
        if template is not None:
            try:
                undeclared_variables(template)
            except Exception as e:
                raise ValueError(f"invalid template syntax: {e}") from e
        return template

    @field_validator("include_history")
    @classmethod
    def _true_is_default(cls, include: bool | None) -> bool | None:
        return None if include else include
