"""
Running a pipeline's test cases, and comparing variants of it — the same
pipeline with other models for some nodes — on the same cases.

Each case is one run of the pipeline with no conversation before it. Its
answer (the output node's) is checked against the case's expectations:

  contains / not_contains  case-insensitive substring tests
  check                    a condition on `output`, the language branch
                           conditions use (safe_eval.py)
  judge                    a requirement the pipeline's judge model grades
                           PASS or FAIL, explaining why

A case without expectations just shows its answer — enough to compare what
different models say. Cases run one at a time (local models usually share
one GPU), each variant in turn, so results fill in case by case.
"""

import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Literal, cast

from langgraph.graph.state import CompiledStateGraph
from pydantic import BaseModel

from llm_pipeline.api_schemas import (
    CaseResult,
    CaseStartEvent,
    ExpectationResult,
    TestsDoneEvent,
    VariantSummary,
)
from llm_pipeline.history import prepare_input
from llm_pipeline.pipeline_config import EvalCase, EvalExpectation, EvalJudge, PipelineDefinition
from llm_pipeline.pipeline_config.effective import effective_model
from llm_pipeline.pipeline_config.schema import DEFAULT_TEMPERATURE
from llm_pipeline.pipeline_config.templates import render
from llm_pipeline.providers import ModelSpec, generate_with_retry, get_provider
from llm_pipeline.providers.resilience import CircuitBreaker
from llm_pipeline.safe_eval import evaluate_condition
from llm_pipeline.state import NodeResult, PipelineState

# Grades one requirement: (question, answer, requirement) -> the judge's reply.
Judge = Callable[[str, str, str], Awaitable[str]]

_VERDICT = re.compile(r"\b(PASS|FAIL)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Variant:
    label: str
    definition: PipelineDefinition
    graph: CompiledStateGraph


def make_judge(
    config: EvalJudge, definition: PipelineDefinition, circuit_breaker: CircuitBreaker
) -> Judge:
    """Calls the judge model with the pipeline's timeout and retries."""
    model = effective_model(config.model, None)
    assert model is not None
    spec = ModelSpec(
        model.provider,
        model.model,
        model.temperature if model.temperature is not None else DEFAULT_TEMPERATURE,
        model.options,
    )
    execution = definition.execution

    async def judge(question: str, answer: str, requirement: str) -> str:
        prompt = render(
            config.prompt, {"question": question, "answer": answer, "criterion": requirement}
        )
        generation = await generate_with_retry(
            get_provider(spec),
            prompt,
            spec,
            execution.model_timeout_seconds,
            max_attempts=execution.max_retries + 1,
            backoff_base_seconds=execution.retry_backoff_seconds,
            circuit_breaker=circuit_breaker,
        )
        return generation.text

    return judge


async def check_expectation(
    expectation: EvalExpectation, question: str, answer: str, judge: Judge | None
) -> ExpectationResult:
    kind: Literal["contains", "not_contains", "check", "judge"]
    if expectation.contains is not None:
        kind, expected = "contains", expectation.contains
        return ExpectationResult(
            kind=kind, expected=expected, passed=expected.casefold() in answer.casefold()
        )
    if expectation.not_contains is not None:
        kind, expected = "not_contains", expectation.not_contains
        return ExpectationResult(
            kind=kind, expected=expected, passed=expected.casefold() not in answer.casefold()
        )
    if expectation.check is not None:
        try:
            passed = evaluate_condition(expectation.check, answer, question)
        except Exception as e:
            return ExpectationResult(
                kind="check", expected=expectation.check, passed=False, detail=str(e)
            )
        return ExpectationResult(kind="check", expected=expectation.check, passed=passed)

    requirement = cast(str, expectation.judge)
    if judge is None:  # validation requires a judge model; kept for safety
        return ExpectationResult(
            kind="judge", expected=requirement, passed=False, detail="no judge model set"
        )
    try:
        reply = (await judge(question, answer, requirement)).strip()
    except Exception as e:
        return ExpectationResult(
            kind="judge", expected=requirement, passed=False, detail=f"the judge failed: {e}"
        )
    verdict = _VERDICT.search(reply)
    return ExpectationResult(
        kind="judge",
        expected=requirement,
        passed=verdict is not None and verdict.group(1).upper() == "PASS",
        detail=reply if verdict is not None else f"no PASS/FAIL in the judge's reply: {reply}",
    )


def _answer_of(definition: PipelineDefinition, outputs: dict[str, NodeResult]) -> str | None:
    return next((c for c in definition.output_node_candidates if c in outputs), None)


async def run_case(variant: Variant, case: EvalCase, judge: Judge | None) -> CaseResult:
    started = time.monotonic()
    definition = variant.definition
    prepared = await prepare_input(case.input, [], definition, None)
    state: PipelineState = {
        "input": prepared.question,
        "contextual_input": prepared.contextual,
        "history": prepared.history,
        "node_outputs": {},
        "loop_counts": {},
    }

    def failed(error: str) -> CaseResult:
        return CaseResult(
            case=case.name,
            variant=variant.label,
            passed=False,
            error=error,
            duration_ms=(time.monotonic() - started) * 1000,
        )

    try:
        final = cast(PipelineState, await variant.graph.ainvoke(state))
    except Exception as e:
        return failed(str(e))
    outputs = final["node_outputs"]
    output_node = _answer_of(definition, outputs)
    if output_node is None:
        return failed("none of the output node candidates produced a result")
    answer = outputs[output_node]["output"]
    duration_ms = (time.monotonic() - started) * 1000  # the pipeline, not the judge

    results = [await check_expectation(e, case.input, answer, judge) for e in case.expect]
    reported = [r["usage"] for r in outputs.values() if "usage" in r]
    return CaseResult(
        case=case.name,
        variant=variant.label,
        passed=all(r.passed for r in results) if results else None,
        answer=answer,
        output_node=output_node,
        expectations=results,
        duration_ms=duration_ms,
        prompt_tokens=sum(u["prompt_tokens"] or 0 for u in reported),
        completion_tokens=sum(u["completion_tokens"] or 0 for u in reported),
    )


def summarize(label: str, results: list[CaseResult]) -> VariantSummary:
    return VariantSummary(
        variant=label,
        passed=sum(1 for r in results if r.passed is True),
        failed=sum(1 for r in results if r.passed is False and r.error is None),
        errors=sum(1 for r in results if r.error is not None),
        unchecked=sum(1 for r in results if r.passed is None),
        duration_ms=sum(r.duration_ms for r in results),
        prompt_tokens=sum(r.prompt_tokens for r in results),
        completion_tokens=sum(r.completion_tokens for r in results),
    )


async def run_tests(
    variants: list[Variant], cases: list[EvalCase], judge: Judge | None
) -> AsyncIterator[tuple[str, BaseModel]]:
    """case_start / case_result per case and variant, then tests_done."""
    results: dict[str, list[CaseResult]] = {v.label: [] for v in variants}
    for case in cases:
        for variant in variants:
            yield "case_start", CaseStartEvent(case=case.name, variant=variant.label)
            result = await run_case(variant, case, judge)
            results[variant.label].append(result)
            yield "case_result", result
    yield (
        "tests_done",
        TestsDoneEvent(summaries=[summarize(v.label, results[v.label]) for v in variants]),
    )
