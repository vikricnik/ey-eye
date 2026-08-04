from llm_pipeline.providers.base import ModelSpec


class GeminiProvider:
    def __init__(self, spec: ModelSpec) -> None:
        from langchain_google_genai import ChatGoogleGenerativeAI  # pyright: ignore[reportMissingImports]

        self._llm = ChatGoogleGenerativeAI(model=spec.model, temperature=spec.temperature)

    async def generate(self, prompt: str) -> str:
        result = await self._llm.ainvoke(prompt)
        return str(result.content)
