from llm_pipeline.providers.base import ModelSpec


class OpenAIProvider:
    def __init__(self, spec: ModelSpec) -> None:
        from langchain_openai import ChatOpenAI  # pyright: ignore[reportMissingImports]

        self._llm = ChatOpenAI(model=spec.model, temperature=spec.temperature)

    async def generate(self, prompt: str) -> str:
        result = await self._llm.ainvoke(prompt)
        return str(result.content)
