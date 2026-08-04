from llm_pipeline.providers.base import ModelSpec
from llm_pipeline.settings import settings


class OllamaProvider:
    def __init__(self, spec: ModelSpec) -> None:
        from langchain_ollama import OllamaLLM

        self._llm = OllamaLLM(
            model=spec.model, temperature=spec.temperature, base_url=settings.ollama_base_url
        )

    async def generate(self, prompt: str) -> str:
        result: str = await self._llm.ainvoke(prompt)
        return result
