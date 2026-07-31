from llm_pipeline.nodes import build_contextual_prompt
from llm_pipeline.models import ConversationTurn


def test_no_history_returns_prompt_unchanged() -> None:
    result = build_contextual_prompt("hello", [])
    assert result == "hello"


def test_history_is_folded_into_prompt() -> None:
    history = [ConversationTurn(prompt="what is 2+2", final_answer="4")]
    result = build_contextual_prompt("and 3+3?", history)

    assert "what is 2+2" in result
    assert "4" in result
    assert "and 3+3?" in result
    assert result.endswith("New request: and 3+3?")
