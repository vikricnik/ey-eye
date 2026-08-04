from llm_pipeline.models import ConversationTurn


def build_contextual_input(current_prompt: str, history: list[ConversationTurn]) -> str:
    """Folds prior turns into the current prompt as plain-text context.

    Note: this replays full history into every node's resolved {input}
    placeholder on every request. Fine for short conversations; for
    long-running sessions consider summarizing history instead of replaying
    it verbatim to keep token cost and latency bounded — see README.
    """
    if not history:
        return current_prompt

    context = "\n\n".join(
        f"User: {turn.prompt}\nAssistant: {turn.final_answer}" for turn in history
    )
    return f"Conversation so far:\n{context}\n\nNew request: {current_prompt}"
