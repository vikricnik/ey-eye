from llm_pipeline.history import build_contextual_input
from llm_pipeline.api_schemas import ConversationTurn


def test_no_history_returns_prompt_unchanged() -> None:
    assert build_contextual_input("hello", []) == "hello"


def test_history_is_folded_into_prompt() -> None:
    history = [ConversationTurn(prompt="what is 2+2", final_answer="4")]
    result = build_contextual_input("and 3+3?", history)

    assert "what is 2+2" in result
    assert "4" in result
    assert result.endswith("New request: and 3+3?")
