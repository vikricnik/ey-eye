from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    ollama_base_url: str = "http://localhost:11434"
    cors_allowed_origins: str = "*"

    # Directory containing pipeline YAML definitions. Relative paths are
    # resolved against the current working directory the server is started
    # from — set an absolute path in production deployments.
    pipelines_dir: str = "pipelines"

    # Used when a client doesn't specify pipeline_name explicitly (mainly
    # convenient for quick manual testing / curl); real clients should
    # always send pipeline_name explicitly.
    default_pipeline_name: str = "consensus-qa"

    # --- Auth ---
    # Comma-separated list of valid API keys. Empty (the default) means auth
    # is DISABLED — fine for local development, but a real gap in anything
    # reachable beyond localhost. Set this to enable a startup warning to
    # stop, and require `Authorization: Bearer <key>` (or `X-API-Key: <key>`)
    # on /ask, /pipelines, and /pipelines/{name}. /health stays open, since
    # load balancers/orchestrators typically probe it without credentials.
    api_keys: str = ""

    # --- Rate limiting ---
    # Per-client (per API key, or per IP if auth is disabled) request cap.
    # A simple in-process fixed-window limiter — fine for a single instance;
    # for multiple instances behind a load balancer you'd want a shared
    # store (e.g. Redis) instead, which this doesn't implement.
    rate_limit_requests_per_minute: int = 60

    # --- Prompt/history safety ---
    # Basic length caps — not a substitute for real prompt-injection defenses,
    # but cheap insurance against a client sending something absurd that
    # balloons token cost or hits provider-side request size limits.
    max_prompt_length: int = 8000
    max_history_turn_length: int = 8000

    # --- Startup validation ---
    # Cheap: re-validates every pipelines/*.yaml file's schema at startup
    # (same checks as CI should run) so a broken file is visible in server
    # logs immediately, not just when a client happens to request it. Does
    # NOT ping real models — that would cost time/money and have side effects
    # for cloud providers, so it's deliberately schema-only.
    validate_pipelines_on_startup: bool = True

    # --- Circuit breaker ---
    # After this many CONSECUTIVE failures for a given model, stop calling it
    # for `circuit_breaker_cooldown_seconds` (fail fast instead of paying the
    # timeout cost every single request) — then allow one trial call to see
    # if it's recovered.
    circuit_breaker_failure_threshold: int = 3
    circuit_breaker_cooldown_seconds: float = 30.0

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_allowed_origins.split(",")]

    @property
    def pipelines_path(self) -> Path:
        return Path(self.pipelines_dir)

    @property
    def api_keys_list(self) -> list[str]:
        return [k.strip() for k in self.api_keys.split(",") if k.strip()]


settings: Settings = Settings()
