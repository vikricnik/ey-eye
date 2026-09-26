from llm_pipeline.providers.base import (
    Generation,
    ModelSpec,
    chat_messages,
    generation_from_message,
)


class OpenAIProvider:
    def __init__(self, spec: ModelSpec) -> None:
        from langchain_openai import ChatOpenAI  # pyright: ignore[reportMissingImports]

        self._llm = ChatOpenAI(model=spec.model, temperature=spec.temperature)

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        return generation_from_message(await self._llm.ainvoke(chat_messages(prompt, system)))
