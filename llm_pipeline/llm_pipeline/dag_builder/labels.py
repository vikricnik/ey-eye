"""
Matching a classifier node's answer to one of its `labels`.

Small models rarely answer with the bare word they were asked for — they
add punctuation, markdown, a sentence of explanation, or reasoning first.
Matching is forgiving about that, but never guesses between labels.
"""

import re

from llm_pipeline.dag_builder.reasoning import strip_reasoning

# Wrapping that doesn't change which label was meant: quotes, markdown
# emphasis, trailing punctuation.
_WRAPPING = " \t\r\n\"'`*_.,:;!?()[]"


def _bare(text: str) -> str:
    return text.strip(_WRAPPING).casefold()


def match_label(answer: str, labels: list[str]) -> str | None:
    """The label `answer` names, spelled as in `labels`; None when it names
    none of them, or more than one. Tried in order: the whole answer is
    the label, its first line is, exactly one label appears in it as a
    whole word."""
    text = strip_reasoning(answer)
    by_bare = {_bare(label): label for label in labels}

    first_line = next((line for line in text.splitlines() if line.strip()), "")
    for candidate in (text, first_line):
        if _bare(candidate) in by_bare:
            return by_bare[_bare(candidate)]

    mentioned = [
        label
        for label in labels
        if re.search(rf"(?<!\w){re.escape(label)}(?!\w)", text, re.IGNORECASE)
    ]
    return mentioned[0] if len(mentioned) == 1 else None
