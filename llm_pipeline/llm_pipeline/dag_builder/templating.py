"""
Template rendering (Jinja2 — supports {% if x is defined %} guards, which
plain string substitution can't express and loops genuinely need: a loop's
back_to target references its own loop's `from_` node's output, which
hasn't run yet on the very first iteration).

Rendering goes through the sandboxed environment in
pipeline_config/templates.py — templates can come from editor clients.
"""

from llm_pipeline.pipeline_config.templates import render
from llm_pipeline.state import NodeResult


class _NodeOutputView:
    """Exposes a completed node's result as `{{ node_id.output }}` in Jinja."""

    __slots__ = ("output",)

    def __init__(self, output: str) -> None:
        self.output = output


def render_template(
    template_str: str,
    node_outputs: dict[str, NodeResult],
    input_text: str,
    question: str | None = None,
    history: str = "",
) -> str:
    """`input_text` is {{ input }} (the new message, with the conversation
    folded in when the node sees history); `question` is just the new
    message and `history` just the earlier turns."""
    context: dict[str, object] = {
        "input": input_text,
        "question": question if question is not None else input_text,
        "history": history,
    }
    for node_id, result in node_outputs.items():
        context[node_id] = _NodeOutputView(result["output"])
    return render(template_str, context)
