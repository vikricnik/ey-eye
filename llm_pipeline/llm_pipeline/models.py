import operator
from typing import Optional, TypedDict, Annotated
from pydantic import BaseModel


class ConversationTurn(BaseModel):
    """One prior exchange, sent by the client as conversation context."""

    prompt: str
    final_answer: str


class AskRequest(BaseModel):
    prompt: str
    history: list[ConversationTurn] = []


class ValidatorVote(TypedDict):
    validator_name: str  # e.g. "ollama:llama3.2:3b" — provider:model identity
    is_valid: bool
    feedback: Optional[str]


class Candidate(TypedDict):
    model_name: str  # e.g. "ollama:qwen3-coder:30b" — provider:model identity
    answer: str
    is_valid: bool
    feedback: Optional[str]
    votes: list[ValidatorVote]


class AskResponse(BaseModel):
    category: str
    final_answer: str
    winning_model: str  # generator identity that produced the winning answer
    router_model: str  # model identity that performed routing/classification
    judge_model: str  # model identity that performed judging
    candidates: list[dict]


class PipelineState(TypedDict):
    user_prompt: str
    contextual_prompt: str  # user_prompt with history folded in, used for generation
    category: str
    router_model: str
    candidates: Annotated[list[Candidate], operator.add]
    final_answer: Optional[str]
    winning_model: Optional[str]
    judge_model: Optional[str]
