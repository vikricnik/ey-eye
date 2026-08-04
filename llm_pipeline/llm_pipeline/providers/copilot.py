from llm_pipeline.providers.base import ModelSpec


class CopilotProvider:
    """Placeholder adapter.

    GitHub Copilot doesn't expose a general-purpose public chat/completion API in
    the same shape as the others — it's IDE-integrated and code-completion focused
    (via the Copilot extension protocol / LSP, not a REST chat endpoint). If your
    organization has access to a Copilot-compatible enterprise endpoint, implement
    `generate()` here to call it. Left as a stub so the ProviderType enum and
    pipeline YAML files can reference it without breaking anything today.
    """

    def __init__(self, spec: ModelSpec) -> None:
        self._spec = spec

    async def generate(self, prompt: str) -> str:
        raise NotImplementedError(
            "CopilotProvider is a placeholder — no public general-purpose completion "
            "API exists for Copilot today. Implement generate() if you have access to "
            "a compatible endpoint."
        )
