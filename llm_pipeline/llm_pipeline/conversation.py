"""
A conversation's earlier turns: what clients send back as context and what
history.py folds into prompts. Framework-free, so the history logic and the
wire contract (api_schemas.py uses this same class) share one type without
the inner layer importing the outer one.
"""

from pydantic import BaseModel


class ConversationTurn(BaseModel):
    """One prior exchange, sent by the client as conversation context."""

    prompt: str
    final_answer: str
    # Node outputs the pipeline asked to remember with this turn (its
    # `history.remember`) — clients send back what `remembered` gave them.
    outputs: dict[str, str] = {}
