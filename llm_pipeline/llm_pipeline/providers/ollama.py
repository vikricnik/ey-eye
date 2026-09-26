from llm_pipeline.providers.base import (
    Generation,
    ModelSpec,
    chat_messages,
    generation_from_message,
)
from llm_pipeline.settings import settings


class OllamaProvider:
    """Uses ChatOllama (Ollama's /api/chat) rather than OllamaLLM
    (/api/generate) so a node's system prompt is sent as a genuine system
    message through the model's own chat template."""

    def __init__(self, spec: ModelSpec) -> None:
        from langchain_ollama import ChatOllama

        options = spec.options.model_dump(exclude_none=True) if spec.options else {}
        if "stop" in options:
            options["stop"] = list(options["stop"])
        self._llm = ChatOllama(
            model=spec.model,
            temperature=spec.temperature,
            base_url=settings.ollama_base_url,
            **options,
        )

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        return generation_from_message(await self._llm.ainvoke(chat_messages(prompt, system)))
