from typing import Literal
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    llm_pipeline_mode: Literal["parallel", "sequential"] = "parallel"
    llm_generation_collaboration: Literal["independent", "collaborative"] = "independent"
    llm_validation_mode: Literal["single", "multiple"] = "single"
    llm_validation_quorum: float = 0.5
    llm_validation_concurrency: Literal["parallel", "sequential"] = "sequential"
    llm_max_history_turns: int = 6
    llm_model_timeout_seconds: float = 60.0

    ollama_base_url: str = "http://localhost:11434"
    cors_allowed_origins: str = "*"

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_allowed_origins.split(",")]


settings: Settings = Settings()
