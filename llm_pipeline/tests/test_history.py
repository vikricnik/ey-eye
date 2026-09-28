"""Conversation history: format, budget, summaries, remembered outputs."""

from typing import Any

import pytest

from llm_pipeline.api_schemas import ConversationTurn
from llm_pipeline.history import prepare_input
from llm_pipeline.pipeline_config import PipelineDefinition


def _definition(history: dict[str, Any] | None = None, max_turns: int = 6) -> PipelineDefinition:
    return PipelineDefinition.model_validate(
        {
            "name": "p",
            "history": {"max_turns": max_turns, **(history or {})},
            "nodes": [
                {
                    "id": "classify",
                    "model": {"provider": "ollama", "name": "m"},
                    "prompt_template": "{{ question }}",
                },
                {
                    "id": "answer",
                    "depends_on": ["classify"],
                    "model": {"provider": "ollama", "name": "m"},
                    "prompt_template": "{{ input }}",
                },
            ],
            "output_nodes": ["answer"],
        }
    )


def _turns(n: int) -> list[ConversationTurn]:
    return [ConversationTurn(prompt=f"q{i}", final_answer=f"a{i}") for i in range(1, n + 1)]


@pytest.mark.asyncio
async def test_no_history_leaves_the_message_alone() -> None:
    prepared = await prepare_input("hello", [], _definition())
    assert (prepared.question, prepared.history, prepared.contextual) == ("hello", "", "hello")


@pytest.mark.asyncio
async def test_default_format_matches_the_original_fixed_format() -> None:
    prepared = await prepare_input(
        "and 3+3?", [ConversationTurn(prompt="2+2?", final_answer="4")], _definition()
    )
    assert (
        prepared.contextual
        == "Conversation so far:\nUser: 2+2?\nAssistant: 4\n\nNew request: and 3+3?"
    )
    assert prepared.history == "User: 2+2?\nAssistant: 4"
    assert prepared.question == "and 3+3?"


@pytest.mark.asyncio
async def test_max_turns_keeps_the_most_recent_and_zero_turns_history_off() -> None:
    prepared = await prepare_input("now", _turns(5), _definition(max_turns=2))
    assert "q3" not in prepared.history and "q4" in prepared.history and "q5" in prepared.history
    off = await prepare_input("now", _turns(5), _definition(max_turns=0))
    assert off.contextual == "now" and off.history == ""


@pytest.mark.asyncio
async def test_custom_turn_template_and_intro() -> None:
    definition = _definition(
        {"intro": "Earlier:", "turn_template": "Q: {{ prompt }} / A: {{ final_answer }}"}
    )
    prepared = await prepare_input("next", _turns(2), definition)
    assert prepared.contextual == "Earlier:\nQ: q1 / A: a1\n\nQ: q2 / A: a2\n\nNew request: next"
    # {{ answer }} is the older name of {{ final_answer }}.
    older = _definition({"turn_template": "Q: {{ prompt }} / A: {{ answer }}"})
    assert (await prepare_input("next", _turns(1), older)).history == "Q: q1 / A: a1"


@pytest.mark.asyncio
async def test_character_budget_drops_the_oldest_turns_first() -> None:
    turns = [ConversationTurn(prompt="x" * 150, final_answer=f"answer {i}") for i in range(1, 5)]
    prepared = await prepare_input("now", turns, _definition({"max_chars": 400}))
    assert "answer 4" in prepared.history and "answer 3" in prepared.history
    assert "answer 1" not in prepared.history
    assert len(prepared.history) <= 400


@pytest.mark.asyncio
async def test_remembered_outputs_are_written_with_their_turn() -> None:
    definition = _definition({"remember": ["classify"]})
    turn = ConversationTurn(prompt="tell a joke", final_answer="…", outputs={"classify": "JOKE"})
    prepared = await prepare_input("another", [turn], definition)
    assert prepared.history == "User: tell a joke\nclassify: JOKE\nAssistant: …"


@pytest.mark.asyncio
async def test_turns_that_dont_fit_are_summarized() -> None:
    definition = _definition(
        {"summarize": {"model": {"provider": "ollama", "name": "small"}}}, max_turns=2
    )
    seen: list[str] = []

    async def summarize(text: str) -> str:
        seen.append(text)
        return "  the user asked q1 and q2  "

    prepared = await prepare_input("now", _turns(4), definition, summarize)
    assert seen == ["User: q1\nAssistant: a1\n\nUser: q2\nAssistant: a2"]
    assert prepared.history.startswith(
        "Summary of the earlier conversation: the user asked q1 and q2\n\n"
    )
    assert prepared.history.endswith("User: q4\nAssistant: a4")


@pytest.mark.asyncio
async def test_a_failing_summary_falls_back_to_dropping_old_turns() -> None:
    definition = _definition(
        {"summarize": {"model": {"provider": "ollama", "name": "small"}}}, max_turns=1
    )

    async def broken(text: str) -> str:
        raise RuntimeError("model down")

    prepared = await prepare_input("now", _turns(3), definition, broken)
    assert prepared.history == "User: q3\nAssistant: a3"


def test_history_settings_are_validated() -> None:
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="unknown node 'nope'"):
        _definition({"remember": ["nope"]})
    with pytest.raises(ValidationError, match="unknown variable"):
        _definition({"turn_template": "{{ promptt }}"})
    with pytest.raises(ValidationError, match="must include"):
        _definition({"summarize": {"model": {"provider": "ollama", "name": "m"}, "prompt": "hi"}})
    with pytest.raises(ValidationError):
        _definition({"max_chars": 10})
