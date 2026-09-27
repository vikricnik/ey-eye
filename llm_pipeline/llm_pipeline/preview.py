"""
What a node would receive, without running anything: its prompt rendered
from a (possibly unsaved) definition, a message, the conversation so far and
other nodes' outputs — typically the last run's. Editor clients show it
while a prompt is being written.

Rendering goes through the same function a run uses, so the preview is
exactly what the model would get — except that older turns a run would
summarize are left out here (previews never call a model).
"""

from dataclasses import dataclass

from llm_pipeline.conversation import ConversationTurn
from llm_pipeline.dag_builder.node_types import render_node_prompt
from llm_pipeline.history import prepare_input
from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.pipeline_config.effective import effective_node
from llm_pipeline.state import NodeResult, PipelineState

MESSAGE_PLACEHOLDER = "<your message>"


def output_placeholder(node_id: str) -> str:
    return f"<{node_id}'s output>"


@dataclass(frozen=True)
class PromptPreview:
    prompt: str
    system: str | None
    # Inputs with no output given, shown as placeholders.
    missing: list[str]


async def preview_prompt(
    definition: PipelineDefinition,
    node_id: str,
    message: str,
    history: list[ConversationTurn],
    outputs: dict[str, str],
) -> PromptPreview:
    """Raises KeyError for an unknown node; rendering errors propagate."""
    node = next((n for n in definition.nodes if n.id == node_id), None)
    if node is None:
        raise KeyError(node_id)
    effective = effective_node(definition, node)
    prepared = await prepare_input(message or MESSAGE_PLACEHOLDER, history, definition, None)

    known = {n.id for n in definition.nodes}
    missing = [dep for dep in node.depends_on if dep not in outputs]

    def result(other: str, text: str) -> NodeResult:
        return {"node_id": other, "model_name": "", "output": text, "duration_ms": 0.0}

    node_outputs = {other: result(other, text) for other, text in outputs.items() if other in known}
    node_outputs.update({dep: result(dep, output_placeholder(dep)) for dep in missing})
    state: PipelineState = {
        "input": prepared.question,
        "contextual_input": prepared.contextual,
        "history": prepared.history,
        "node_outputs": node_outputs,
        "loop_counts": {},
    }
    return PromptPreview(
        render_node_prompt(node, effective, state), effective.system_prompt, missing
    )
