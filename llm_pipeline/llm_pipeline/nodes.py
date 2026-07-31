import asyncio
import logging
from typing import Optional

from llm_pipeline.category import Category
from llm_pipeline.providers import ModelSpec, get_provider, generate_with_timeout, ProviderError
from llm_pipeline.errors import PipelineExecutionError
from llm_pipeline.model_registry import (
    ROUTER_SPEC,
    JUDGE_SPEC,
    GENERATOR_SPECS,
    VALIDATOR_SPECS,
)
from llm_pipeline.config import (
    EXECUTION_MODE,
    GENERATION_COLLABORATION,
    VALIDATION_MODE,
    VALIDATION_QUORUM,
    VALIDATION_CONCURRENCY,
    MODEL_TIMEOUT_SECONDS,
)
from llm_pipeline.models import PipelineState, Candidate, ValidatorVote, ConversationTurn

logger: logging.Logger = logging.getLogger("llm_pipeline")


# ---------------------------------------------------------------------------
# Conversation history
# ---------------------------------------------------------------------------

def build_contextual_prompt(current_prompt: str, history: list[ConversationTurn]) -> str:
    """Folds prior turns into the current prompt as plain-text context.

    Note: this replays full history on every tier (router, each generator,
    each validator, judge) for every turn. Fine for short conversations;
    for long-running sessions consider summarizing history instead of
    replaying it verbatim to keep token cost and latency bounded.
    """
    if not history:
        return current_prompt

    context = "\n\n".join(
        f"User: {turn.prompt}\nAssistant: {turn.final_answer}" for turn in history
    )
    return f"Conversation so far:\n{context}\n\nNew request: {current_prompt}"


# ---------------------------------------------------------------------------
# Tier 1: Route
# ---------------------------------------------------------------------------

async def route_node(state: PipelineState) -> dict[str, str]:
    """Classifies the request into a Category. If the router model itself fails
    (timeout, API error, etc.), we don't crash the whole request over a
    classification step — fall back to GENERAL and let generation proceed."""
    provider = get_provider(ROUTER_SPEC)

    category_list = ", ".join(c.value for c in Category)
    prompt: str = (
        f"Classify this request into exactly one category: {category_list}. "
        f"Respond with only the category word.\n\n"
        f"Request: {state['contextual_prompt']}"
    )

    try:
        result: str = await generate_with_timeout(
            provider, prompt, ROUTER_SPEC, MODEL_TIMEOUT_SECONDS
        )
        category: Category = Category.from_str(result)
    except ProviderError as e:
        logger.warning(f"[route] router model failed ({e}); defaulting to GENERAL")
        category = Category.GENERAL

    logger.info(f"[route] category={category.value} model={ROUTER_SPEC.identity}")
    return {"category": category.value, "router_model": ROUTER_SPEC.identity}


# ---------------------------------------------------------------------------
# Tier 2: Generate (+ validate inline per candidate)
# ---------------------------------------------------------------------------

def _build_validation_prompt(user_prompt: str, answer: str) -> str:
    return (
        f"Question: {user_prompt}\n\n"
        f"Proposed answer: {answer}\n\n"
        'Is this answer correct and complete? Reply with "VALID" if good, '
        'or "INVALID: <reason>" if there is a problem.'
    )


async def _run_single_vote(spec: ModelSpec, prompt: str) -> ValidatorVote:
    """Raises ProviderError on failure — callers are responsible for isolating
    that failure so one bad validator doesn't take down the whole vote."""
    provider = get_provider(spec)
    result: str = await generate_with_timeout(provider, prompt, spec, MODEL_TIMEOUT_SECONDS)
    is_valid: bool = result.strip().upper().startswith("VALID")
    return {
        "validator_name": spec.identity,
        "is_valid": is_valid,
        "feedback": None if is_valid else result,
    }


async def _run_validation(
    category: Category, user_prompt: str, answer: str
) -> tuple[bool, Optional[str], list[ValidatorVote]]:
    """Validates one answer using the validator(s) configured for this category.

    Each validator's failure is isolated: a validator that times out or errors is
    dropped from the vote (logged as a warning) rather than crashing the request.
    Quorum is computed only over validators that actually responded. If every
    validator for this category fails, the answer is conservatively marked
    invalid (we can't confirm quality, so we don't approve it by default).
    """
    specs: list[ModelSpec] = VALIDATOR_SPECS[category]
    if VALIDATION_MODE == "single":
        specs = specs[:1]

    prompt: str = _build_validation_prompt(user_prompt, answer)

    votes: list[ValidatorVote] = []

    if VALIDATION_CONCURRENCY == "parallel" and len(specs) > 1:
        results = await asyncio.gather(
            *[_run_single_vote(s, prompt) for s in specs], return_exceptions=True
        )
        for spec, result in zip(specs, results):
            if isinstance(result, BaseException):
                logger.warning(f"[validator:{spec.identity}] validation failed: {result}")
                continue
            votes.append(result)
    else:
        for spec in specs:
            try:
                vote = await _run_single_vote(spec, prompt)
                votes.append(vote)
            except ProviderError as e:
                logger.warning(f"[validator:{spec.identity}] validation failed: {e}")
                continue

    if not votes:
        return (
            False,
            f"All {len(specs)} validator(s) for {category.value} failed to respond; "
            f"treating answer as unvalidated (not approved).",
            [],
        )

    valid_count: int = sum(1 for v in votes if v["is_valid"])
    total_count: int = len(votes)
    is_valid: bool = (valid_count / total_count) >= VALIDATION_QUORUM

    feedback: Optional[str] = None
    if not is_valid:
        reasons: list[str] = [v["feedback"] for v in votes if v["feedback"]]
        feedback = (
            f"{valid_count}/{total_count} validators approved. Issues raised: "
            + "; ".join(reasons)
        )

    logger.info(
        f"[validate:{category.value}:{VALIDATION_MODE}:{VALIDATION_CONCURRENCY}] "
        f"{valid_count}/{total_count} approved (quorum={VALIDATION_QUORUM})"
    )
    return is_valid, feedback, votes


def _build_collaborative_prompt(
    contextual_prompt: str, previous_candidates: list[Candidate]
) -> str:
    """Each generator sees the most recent answer and is asked to improve it."""
    if not previous_candidates:
        return contextual_prompt

    latest: Candidate = previous_candidates[-1]
    history_text: str = "\n\n".join(
        f"Attempt by {c['model_name']}:\n{c['answer']}" for c in previous_candidates
    )

    return (
        f"{contextual_prompt}\n\n"
        f"Prior attempt(s):\n{history_text}\n\n"
        f"Review the most recent attempt (by {latest['model_name']}) above. "
        f"Improve it, fix any mistakes, or add anything missing. "
        f"Provide your own complete, improved answer (not just a diff or comment)."
    )


async def _generate_one(
    spec: ModelSpec,
    category: Category,
    contextual_prompt: str,
    user_prompt: str,
    prior_candidates: list[Candidate],
) -> Candidate:
    """Generates one candidate answer with a single model, then validates it.
    Raises ProviderError if generation itself fails — callers isolate that
    failure so one bad generator doesn't take down the whole request."""
    provider = get_provider(spec)

    if GENERATION_COLLABORATION == "collaborative" and prior_candidates:
        prompt = _build_collaborative_prompt(contextual_prompt, prior_candidates)
    else:
        prompt = contextual_prompt

    answer: str = await generate_with_timeout(provider, prompt, spec, MODEL_TIMEOUT_SECONDS)
    is_valid, feedback, votes = await _run_validation(category, user_prompt, answer)

    logger.info(
        f"[candidate:{spec.identity}] category={category.value} "
        f"collaboration={GENERATION_COLLABORATION} is_valid={is_valid}"
    )

    return {
        "model_name": spec.identity,
        "answer": answer,
        "is_valid": is_valid,
        "feedback": feedback,
        "votes": votes,
    }


async def generate_and_validate_node(state: PipelineState) -> dict[str, list[Candidate]]:
    """Runs every generator configured for the current category, either
    concurrently (EXECUTION_MODE=parallel) or one after another
    (EXECUTION_MODE=sequential, optionally collaborative).

    Each generator's failure is isolated — a model that times out or errors is
    dropped from the candidate pool (logged as a warning) rather than crashing
    the request. Only if EVERY generator for the category fails do we raise
    PipelineExecutionError, since there'd be nothing left to judge.

    This single node replaces the old per-model static graph nodes — since the
    set of generators now varies by category (resolved at runtime, after routing),
    a fixed graph shape can't represent it. Fan-out/fan-in happens inside this
    function instead, via asyncio.gather for parallel mode or a plain loop for
    sequential mode.
    """
    category: Category = Category(state["category"])
    generator_specs: list[ModelSpec] = GENERATOR_SPECS[category]

    candidates: list[Candidate] = []

    if EXECUTION_MODE == "parallel":
        results = await asyncio.gather(
            *[
                _generate_one(
                    spec, category, state["contextual_prompt"], state["user_prompt"], []
                )
                for spec in generator_specs
            ],
            return_exceptions=True,
        )
        for spec, result in zip(generator_specs, results):
            if isinstance(result, BaseException):
                logger.warning(f"[candidate:{spec.identity}] generation failed: {result}")
                continue
            candidates.append(result)
    else:
        for spec in generator_specs:
            try:
                candidate = await _generate_one(
                    spec, category, state["contextual_prompt"], state["user_prompt"], candidates
                )
                candidates.append(candidate)
            except ProviderError as e:
                logger.warning(f"[candidate:{spec.identity}] generation failed: {e}")
                continue

    if not candidates:
        raise PipelineExecutionError(
            f"All {len(generator_specs)} generator(s) configured for category "
            f"{category.value} failed. Check that the configured models are "
            f"reachable (Ollama running, API keys set, etc.)."
        )

    return {"candidates": candidates}


# ---------------------------------------------------------------------------
# Tier 3: Judge
# ---------------------------------------------------------------------------

async def judge_node(state: PipelineState) -> dict[str, str]:
    """Picks the best candidate. If the judge model itself fails, falls back to
    the first valid candidate rather than crashing the whole request — a failed
    judge shouldn't discard otherwise-good generated answers."""
    candidates: list[Candidate] = state["candidates"]

    if not candidates:
        # Shouldn't normally happen — generate_and_validate_node already raises
        # if every generator failed — but guarded here too since judge_node could
        # in principle be reached with an empty list if the graph changes later.
        raise PipelineExecutionError("No candidates available to judge.")

    valid_candidates: list[Candidate] = [c for c in candidates if c["is_valid"]] or candidates

    options_text: str = "\n\n".join(
        f"Option {i+1} (model: {c['model_name']}):\n{c['answer']}"
        for i, c in enumerate(valid_candidates)
    )

    provider = get_provider(JUDGE_SPEC)
    judge_prompt: str = (
        f"Question: {state['user_prompt']}\n\n"
        f"{options_text}\n\n"
        "Which option is the best answer? Consider correctness, completeness, "
        "and clarity. Reply with only the option number (e.g. '2')."
    )

    winner: Candidate
    try:
        result: str = await generate_with_timeout(
            provider, judge_prompt, JUDGE_SPEC, MODEL_TIMEOUT_SECONDS
        )
        idx: int = int(result.strip().split()[0]) - 1
        winner = valid_candidates[idx]
    except (ProviderError, ValueError, IndexError) as e:
        logger.warning(f"[judge] failed or unparseable ({e}); defaulting to first candidate")
        winner = valid_candidates[0]

    logger.info(f"[judge] winner={winner['model_name']} judge_model={JUDGE_SPEC.identity}")

    return {
        "final_answer": winner["answer"],
        "winning_model": winner["model_name"],
        "judge_model": JUDGE_SPEC.identity,
    }
