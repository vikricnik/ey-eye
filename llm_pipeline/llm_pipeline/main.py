import logging
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from llm_pipeline.models import AskRequest, AskResponse, PipelineState
from llm_pipeline.graph import pipeline
from llm_pipeline.nodes import build_contextual_prompt
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.config import (
    EXECUTION_MODE,
    GENERATION_COLLABORATION,
    VALIDATION_MODE,
    VALIDATION_QUORUM,
    VALIDATION_CONCURRENCY,
    MAX_HISTORY_TURNS,
    MODEL_TIMEOUT_SECONDS,
)
from llm_pipeline.model_registry import ROUTER_SPEC, JUDGE_SPEC, GENERATOR_SPECS, VALIDATOR_SPECS
from llm_pipeline.settings import settings

logging.basicConfig(level=logging.INFO)
logger: logging.Logger = logging.getLogger("llm_pipeline")

app: FastAPI = FastAPI(title="LLM Pipeline", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "execution_mode": EXECUTION_MODE,
        "generation_collaboration": GENERATION_COLLABORATION,
        "validation_mode": VALIDATION_MODE,
        "validation_quorum": VALIDATION_QUORUM,
        "validation_concurrency": VALIDATION_CONCURRENCY,
        "max_history_turns": MAX_HISTORY_TURNS,
        "model_timeout_seconds": MODEL_TIMEOUT_SECONDS,
        "router_model": ROUTER_SPEC.identity,
        "judge_model": JUDGE_SPEC.identity,
        "generators_by_category": {
            cat.value: [spec.identity for spec in specs]
            for cat, specs in GENERATOR_SPECS.items()
        },
        "validators_by_category": {
            cat.value: [spec.identity for spec in specs]
            for cat, specs in VALIDATOR_SPECS.items()
        },
    }


@app.post("/ask", response_model=AskResponse)
async def ask(req: AskRequest) -> AskResponse:
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="prompt cannot be empty")

    # Cap history to the configured window to bound token cost/latency
    trimmed_history = req.history[-MAX_HISTORY_TURNS:] if MAX_HISTORY_TURNS > 0 else []
    contextual_prompt = build_contextual_prompt(req.prompt, trimmed_history)

    initial_state: PipelineState = {
        "user_prompt": req.prompt,
        "contextual_prompt": contextual_prompt,
        "category": "",
        "router_model": "",
        "candidates": [],
        "final_answer": None,
        "winning_model": None,
        "judge_model": None,
    }

    try:
        final_state: PipelineState = await pipeline.ainvoke(initial_state)
    except PipelineExecutionError as e:
        # An entire tier had no surviving results after graceful degradation
        # was already attempted (every generator/validator for this category failed).
        logger.exception("Pipeline tier fully failed")
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        logger.exception("Pipeline execution failed")
        raise HTTPException(status_code=502, detail=f"LLM pipeline error: {e}")

    return AskResponse(
        category=final_state["category"],
        final_answer=final_state["final_answer"] or "",
        winning_model=final_state["winning_model"] or "",
        router_model=final_state["router_model"],
        judge_model=final_state["judge_model"] or "",
        candidates=final_state["candidates"],
    )
