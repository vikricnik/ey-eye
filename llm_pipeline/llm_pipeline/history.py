"""
Conversation history: turning the earlier turns a client sends into the
text nodes see — `{{ history }}` (just the earlier turns), and
`{{ conversation }}` (the new message with the history folded in, the
historical format; also called `{{ input }}`).

Per pipeline (HistoryConfig + execution.max_history_turns):
  - how many recent turns are kept verbatim, and a character budget for
    them (oldest dropped first);
  - how each turn is written (a template; remembered node outputs of that
    turn are available to it);
  - optionally, a model that condenses the turns that didn't fit into a
    short recap instead of dropping them. Best effort: if it fails, those
    turns are dropped as they would be without it.

The server keeps no conversation state: clients send the turns (with the
node outputs the pipeline asked to remember) on every request.
"""

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from llm_pipeline.conversation import ConversationTurn
from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.pipeline_config.templates import render

logger: logging.Logger = logging.getLogger("llm_pipeline")

# Condenses rendered earlier turns into a recap (see history.summarize).
Summarizer = Callable[[str], Awaitable[str]]


@dataclass(frozen=True)
class PreparedInput:
    question: str  # {{ message }}: the new message alone
    history: str  # {{ history }}: the earlier turns (and recap), "" if none
    contextual: str  # {{ conversation }}: the new message with history folded in


def render_turn(template: str, turn: ConversationTurn) -> str:
    return render(
        template,
        {"prompt": turn.prompt, "answer": turn.final_answer, "outputs": dict(turn.outputs)},
    ).strip()


def build_contextual_input(question: str, history: str, intro: str) -> str:
    """{{ conversation }} — kept byte-identical to the original fixed format
    ("Conversation so far:\\n…\\n\\nNew request: …") under default settings."""
    if not history:
        return question
    head = f"{intro}\n" if intro else ""
    return f"{head}{history}\n\nNew request: {question}"


async def prepare_input(
    question: str,
    turns: list[ConversationTurn],
    definition: PipelineDefinition,
    summarize: Summarizer | None = None,
) -> PreparedInput:
    config = definition.history
    max_turns = definition.execution.max_history_turns
    if max_turns <= 0 or not turns:
        return PreparedInput(question=question, history="", contextual=question)

    kept = turns[-max_turns:]
    overflow = turns[: len(turns) - len(kept)]
    rendered = [render_turn(config.turn_template, turn) for turn in kept]

    # Character budget: drop (or later summarize) the oldest verbatim turns.
    if config.max_chars is not None:
        while len(rendered) > 1 and len("\n\n".join(rendered)) > config.max_chars:
            overflow.append(kept.pop(0))
            rendered.pop(0)

    history = "\n\n".join(rendered)
    if overflow and config.summarize is not None and summarize is not None:
        older = "\n\n".join(render_turn(config.turn_template, t) for t in overflow)
        try:
            recap = (await summarize(older)).strip()
        except Exception as e:  # a recap is an enhancement, never a reason to fail the run
            logger.warning(f"history summary failed; dropping {len(overflow)} older turn(s): {e}")
            recap = ""
        if recap:
            history = f"Summary of the earlier conversation: {recap}\n\n{history}"

    return PreparedInput(
        question=question,
        history=history,
        contextual=build_contextual_input(question, history, config.intro),
    )
