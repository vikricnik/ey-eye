"""Reasoning that some models write before their actual answer."""

import re

_THINK_BLOCK = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)


def strip_reasoning(text: str) -> str:
    """Removes <think>…</think> reasoning that some models (qwen3,
    deepseek-r1, …) emit before their answer. Also handles a missing
    opening tag (everything up to a stray </think> is reasoning) and an
    unterminated one (everything from <think> on is reasoning)."""
    text = _THINK_BLOCK.sub("", text)
    lower = text.lower()
    closing = lower.rfind("</think>")
    if closing >= 0:
        text = text[closing + len("</think>") :]
    opening = text.lower().find("<think>")
    if opening >= 0:
        text = text[:opening]
    return text.strip()
