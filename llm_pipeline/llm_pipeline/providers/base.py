"""
Base types every provider adapter and consumer depends on.

Kept dependency-free (no adapter imports here) so adapters can each import
this module without any risk of circularity, and so consumers that only
need the *types* (e.g. pipeline_config.py, which references ModelSpec in
its schema) don't pull in every adapter's lazy SDK import machinery.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field


class ProviderType(str, Enum):
    OLLAMA = "ollama"
    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GEMINI = "gemini"
    COPILOT = "copilot"


class OllamaOptions(BaseModel):
    """Ollama-only generation options, passed straight through to the
    Ollama adapter. Every field is optional — unset means "use the model's
    own default" (Ollama reads the Modelfile's PARAMETER values).

    Lives here rather than in pipeline_config/schema.py so ModelSpec (which
    the provider layer owns) can carry it without providers/ importing
    upward into pipeline_config/. schema.py reuses this exact model, so
    there is one definition of what an Ollama option is.

    `extra="forbid"`: a typo'd option name is rejected rather than silently
    ignored. Frozen: ModelSpec is a frozen value object, so its options
    must not be mutable either."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    # Sampling
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)
    top_k: int | None = Field(default=None, ge=1)
    tfs_z: float | None = Field(default=None, ge=0.0)
    repeat_penalty: float | None = Field(default=None, ge=0.0)
    repeat_last_n: int | None = Field(default=None, ge=-1)
    seed: int | None = None
    stop: tuple[str, ...] | None = None
    # Mirostat: 0 = disabled, 1 = Mirostat, 2 = Mirostat 2.0
    mirostat: Literal[0, 1, 2] | None = None
    mirostat_eta: float | None = Field(default=None, ge=0.0)
    mirostat_tau: float | None = Field(default=None, ge=0.0)
    # Context / length
    num_ctx: int | None = Field(default=None, ge=1)
    num_predict: int | None = Field(default=None, ge=-2)
    # Runtime / hardware
    num_gpu: int | None = Field(default=None, ge=0)
    num_thread: int | None = Field(default=None, ge=1)
    keep_alive: int | str | None = None
    # Output format: "json" constrains the model to emit valid JSON.
    format: Literal["json"] | None = None


@dataclass(frozen=True)
class ModelSpec:
    """Identifies one specific model from one specific provider, plus the
    generation settings it is called with."""

    provider: ProviderType
    model: str
    temperature: float = 0.2
    options: OllamaOptions | None = None

    @property
    def identity(self) -> str:
        """Human-readable id used throughout API responses, e.g. 'ollama:qwen3-coder:30b'."""
        return f"{self.provider.value}:{self.model}"

    @property
    def cache_key(self) -> str:
        """Distinguishes two specs for the same model called with different
        settings — the provider registry caches one instance per key, and
        each instance is constructed with its settings baked in."""
        options = self.options.model_dump_json(exclude_none=True) if self.options else ""
        return f"{self.identity}:{self.temperature}:{options}"


@dataclass(frozen=True)
class Usage:
    """What a backend reported about one call. None: not reported (not
    every backend reports everything, and test fakes report nothing)."""

    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    # Time spent generating the reply itself (Ollama's eval_duration) —
    # excludes model loading and prompt processing, so tokens/second
    # derived from it means generation speed.
    generation_ms: float | None = None


@dataclass(frozen=True)
class Generation:
    """A model's reply, with the usage its backend reported."""

    text: str
    usage: Usage | None = None


def generation_from_message(message: object) -> Generation:
    """A Generation from a LangChain chat model's reply: its text, the token
    counts LangChain normalizes into `usage_metadata`, and — for Ollama —
    the generation time in `response_metadata`."""
    content = getattr(message, "content", "")
    usage_metadata = getattr(message, "usage_metadata", None)
    response_metadata = getattr(message, "response_metadata", None)
    counts: dict[str, object] = dict(usage_metadata) if isinstance(usage_metadata, dict) else {}
    metadata: dict[str, object] = (
        dict(response_metadata) if isinstance(response_metadata, dict) else {}
    )
    prompt_tokens = counts.get("input_tokens")
    completion_tokens = counts.get("output_tokens")
    eval_ns = metadata.get("eval_duration")
    usage = Usage(
        prompt_tokens=prompt_tokens if isinstance(prompt_tokens, int) else None,
        completion_tokens=completion_tokens if isinstance(completion_tokens, int) else None,
        generation_ms=eval_ns / 1_000_000
        if isinstance(eval_ns, int | float) and eval_ns > 0
        else None,
    )
    return Generation(str(content), usage if usage != Usage() else None)


class RetrySettings(Protocol):
    """A pipeline's `execution` block (pipeline_config.ExecutionConfig), as
    far as retrying goes — a protocol, so this layer doesn't import the
    definition model."""

    @property
    def model_timeout_seconds(self) -> float: ...
    @property
    def max_retries(self) -> int: ...
    @property
    def retry_backoff_seconds(self) -> float: ...


@dataclass(frozen=True)
class RetryPolicy:
    """How a model call is attempted: at most `max_attempts` tries in all,
    each with a hard timeout, waiting backoff_base_seconds * 2**n before
    retry n."""

    timeout_seconds: float
    max_attempts: int = 2
    backoff_base_seconds: float = 1.0

    @classmethod
    def from_execution(cls, execution: RetrySettings) -> "RetryPolicy":
        """A pipeline's policy: its `max_retries` are the attempts after the
        first."""
        return cls(
            timeout_seconds=execution.model_timeout_seconds,
            max_attempts=execution.max_retries + 1,
            backoff_base_seconds=execution.retry_backoff_seconds,
        )


@runtime_checkable
class LLMProvider(Protocol):
    """The only interface the rest of the pipeline depends on. Any backend
    implementing this (regardless of its native SDK's shape) can be dropped
    into the pipeline — see registry.py for how a ModelSpec becomes one of
    these, and the individual adapter modules (ollama.py, openai.py, ...)
    for how each backend is wrapped to satisfy it."""

    async def generate(self, prompt: str, system: str | None = None) -> Generation:
        """`system`, when given, is sent as a real system message — not
        concatenated into the prompt — so chat-tuned models apply it the
        way they were trained to. The Generation carries the reply, and the
        token usage when the backend reports it (usage=None otherwise)."""
        ...


class ProviderError(Exception):
    """Normalizes any provider failure (timeout, API error, connection refused, ...)
    into one exception type carrying the model's identity, so callers can catch a
    single type regardless of which backend or SDK raised the original error."""

    def __init__(self, model_identity: str, original: BaseException) -> None:
        self.model_identity = model_identity
        self.original = original
        super().__init__(f"{model_identity} failed: {original}")


def chat_messages(prompt: str, system: str | None) -> list[tuple[str, str]]:
    """The (role, content) message list every LangChain chat model accepts
    via ainvoke() — a system message first when one is configured."""
    messages: list[tuple[str, str]] = []
    if system:
        messages.append(("system", system))
    messages.append(("human", prompt))
    return messages
