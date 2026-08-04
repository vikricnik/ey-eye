from llm_pipeline.providers.base import ModelSpec


class AnthropicProvider:
    def __init__(self, spec: ModelSpec) -> None:
        from langchain_anthropic import ChatAnthropic  # pyright: ignore[reportMissingImports]

        self._llm = ChatAnthropic(model=spec.model, temperature=spec.temperature)

    async def generate(self, prompt: str) -> str:
        result = await self._llm.ainvoke(prompt)
        return str(result.content)
