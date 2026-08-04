"""
Template rendering (Jinja2 — supports {% if x is defined %} guards, which
plain string substitution can't express and loops genuinely need: a loop's
back_to target references its own loop's `from_` node's output, which
hasn't run yet on the very first iteration).
"""

from llm_pipeline.state import NodeResult


class _NodeOutputView:
    """Exposes a completed node's result as `{{ node_id.output }}` in Jinja."""

    __slots__ = ("output",)

    def __init__(self, output: str) -> None:
        self.output = output


def render_template(template_str: str, node_outputs: dict[str, NodeResult], input_text: str) -> str:
    from jinja2 import Environment  # local import: keep module import time light

    env = Environment()
    template = env.from_string(template_str)
    context: dict[str, object] = {"input": input_text}
    for node_id, result in node_outputs.items():
        context[node_id] = _NodeOutputView(result["output"])
    # str(...) here isn't redundant: template.render() resolves to `Any`
    # (its exact type depends on jinja2's own stub availability), and
    # returning that directly would leak Any past this function's declared
    # `-> str` return type (mypy's warn_return_any/no-any-return catches
    # exactly this) — str() gives mypy a concrete, guaranteed-str value.
    return str(template.render(**context))
