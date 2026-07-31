from llm_pipeline.settings import settings

EXECUTION_MODE: str = settings.llm_pipeline_mode
GENERATION_COLLABORATION: str = settings.llm_generation_collaboration
VALIDATION_MODE: str = settings.llm_validation_mode
VALIDATION_QUORUM: float = settings.llm_validation_quorum
VALIDATION_CONCURRENCY: str = settings.llm_validation_concurrency
MAX_HISTORY_TURNS: int = settings.llm_max_history_turns
MODEL_TIMEOUT_SECONDS: float = settings.llm_model_timeout_seconds

if GENERATION_COLLABORATION == "collaborative" and EXECUTION_MODE != "sequential":
    raise ValueError(
        "LLM_GENERATION_COLLABORATION=collaborative requires "
        "LLM_PIPELINE_MODE=sequential (collaboration needs a defined order)"
    )
