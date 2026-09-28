"""Test cases: their schema, running them (POST /pipelines/test), and
comparing variants of a pipeline on them."""

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient
from pydantic import ValidationError

import llm_pipeline.dag_builder.node_types as node_types_module
import llm_pipeline.evaluation as evaluation_module
import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.evaluation import check_expectation
from llm_pipeline.main import app
from llm_pipeline.model_catalog import CatalogModel, ModelCatalog
from llm_pipeline.pipeline_config import PipelineDefinition
from llm_pipeline.pipeline_config.schema import EvalExpectation
from llm_pipeline.providers import Generation, ModelSpec, Usage
from llm_pipeline.settings import settings

INSTALLED = ["llama3:latest", "small:latest", "judge:latest"]


def _definition(tests: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "name": "qa",
        "nodes": [
            {
                "id": "answer",
                "model": {"provider": "ollama", "model": "llama3"},
                "prompt_template": "{{ input }}",
            }
        ],
        "output_node": "answer",
        **({"tests": tests} if tests is not None else {}),
    }


TESTS: dict[str, Any] = {
    "judge": {"model": {"provider": "ollama", "model": "judge"}},
    "cases": [
        {
            "name": "capital",
            "input": "What is the capital of France?",
            "expect": [
                {"contains": "paris"},
                {"not_contains": "Berlin"},
                {"check": 'output.startswith("The")'},
                {"judge": "It names Paris as the capital"},
            ],
        },
        {"name": "open", "input": "Tell me a joke"},
    ],
}


def _provider_for(spec: ModelSpec) -> Any:
    class _Provider:
        async def generate(self, prompt: str, system: str | None = None) -> str | Generation:
            if spec.model == "judge":
                # The requirement itself names Paris — look at the answer.
                return (
                    "PASS\nIt says Paris." if "Answer: The capital" in prompt else "FAIL\nNo Paris."
                )
            if spec.model == "small":
                return "Berlin, obviously."
            return Generation(
                "The capital of France is Paris.", Usage(prompt_tokens=20, completion_tokens=8)
            )

    return _Provider()


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(settings, "pipelines_dir", str(tmp_path))
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(settings, "pipeline_editing_enabled", True)
    monkeypatch.setattr(settings, "cors_allowed_origins", "http://localhost:5173")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))
    monkeypatch.setattr(node_types_module, "get_provider", _provider_for)
    monkeypatch.setattr(evaluation_module, "get_provider", _provider_for)

    async def installed() -> list[CatalogModel]:
        return [CatalogModel(name=name) for name in INSTALLED]

    with TestClient(app, raise_server_exceptions=False) as c:
        app.state.pipeline_store.catalog = ModelCatalog(
            "http://ollama.test", [], ollama_lister=installed
        )
        yield c


def _events(text: str) -> list[tuple[str, dict[str, Any]]]:
    events = []
    for block in text.strip().split("\n\n"):
        lines = block.split("\n")
        kind = next(line[6:].strip() for line in lines if line.startswith("event:"))
        data = next(line[5:].strip() for line in lines if line.startswith("data:"))
        events.append((kind, json.loads(data)))
    return events


# -- schema ---------------------------------------------------------------------------


def test_the_tests_block_is_validated() -> None:
    PipelineDefinition.model_validate(_definition(TESTS))
    duplicate = {"cases": [{"name": "a", "input": "x"}, {"name": "a", "input": "y"}]}
    with pytest.raises(ValidationError, match="two cases are named 'a'"):
        PipelineDefinition.model_validate(_definition(duplicate))
    unjudged = {"cases": [{"name": "a", "input": "x", "expect": [{"judge": "is kind"}]}]}
    with pytest.raises(ValidationError, match="no tests.judge model"):
        PipelineDefinition.model_validate(_definition(unjudged))
    two_kinds = {
        "cases": [{"name": "a", "input": "x", "expect": [{"contains": "a", "check": "x"}]}]
    }
    with pytest.raises(ValidationError, match="exactly one of"):
        PipelineDefinition.model_validate(_definition(two_kinds))
    blank = {"cases": [{"name": "a", "input": "x", "expect": [{"contains": " "}]}]}
    with pytest.raises(ValidationError, match="'contains' expectation needs a value"):
        PipelineDefinition.model_validate(_definition(blank))
    unsafe = {"cases": [{"name": "a", "input": "x", "expect": [{"check": "__import__('os')"}]}]}
    with pytest.raises(ValidationError, match="invalid check"):
        PipelineDefinition.model_validate(_definition(unsafe))
    blind = {**TESTS, "judge": {"model": {"provider": "ollama", "model": "j"}, "prompt": "{{ q }}"}}
    with pytest.raises(ValidationError, match="unknown variable"):
        PipelineDefinition.model_validate(_definition(blind))


def test_tests_are_saved_only_when_there_are_some(client: TestClient) -> None:
    empty = client.post("/pipelines/validate", json={"definition": _definition()}).json()
    assert "tests" not in yaml.safe_load(empty["yaml"])
    full = client.post("/pipelines/validate", json={"definition": _definition(TESTS)}).json()
    saved = yaml.safe_load(full["yaml"])
    assert list(saved)[-1] == "tests"  # written last, after the pipeline itself
    assert saved["tests"]["cases"][1] == {"name": "open", "input": "Tell me a joke"}


# -- running --------------------------------------------------------------------------


def test_cases_run_and_every_expectation_is_checked(client: TestClient) -> None:
    response = client.post("/pipelines/test", json={"definition": _definition(TESTS)})
    assert response.status_code == 200
    events = _events(response.text)
    assert [kind for kind, _ in events] == [
        "case_start",
        "case_result",
        "case_start",
        "case_result",
        "tests_done",
    ]
    capital = events[1][1]
    assert capital["passed"] is True and capital["variant"] == "current"
    assert [e["passed"] for e in capital["expectations"]] == [True, True, True, True]
    assert capital["expectations"][3]["detail"] == "PASS\nIt says Paris."
    assert (capital["prompt_tokens"], capital["completion_tokens"]) == (20, 8)
    open_case = events[3][1]
    assert open_case["passed"] is None and open_case["answer"].startswith("The capital")
    (summary,) = events[-1][1]["summaries"]
    assert (summary["passed"], summary["failed"], summary["unchecked"]) == (1, 0, 1)


def test_variants_compare_models_on_the_same_cases(client: TestClient) -> None:
    response = client.post(
        "/pipelines/test",
        json={
            "definition": _definition(TESTS),
            "cases": ["capital"],
            "inputs": ["one more question"],
            "variants": [
                {"label": "small", "models": {"answer": {"provider": "ollama", "model": "small"}}}
            ],
        },
    )
    results = [d for kind, d in _events(response.text) if kind == "case_result"]
    grid = {(r["case"], r["variant"]): r for r in results}
    assert set(grid) == {
        ("capital", "current"),
        ("capital", "small"),
        ("message 1", "current"),
        ("message 1", "small"),
    }
    small = grid[("capital", "small")]
    assert small["passed"] is False
    assert [e["passed"] for e in small["expectations"]] == [False, False, False, False]
    assert small["expectations"][3]["detail"] == "FAIL\nNo Paris."
    assert grid[("message 1", "small")]["answer"] == "Berlin, obviously."


def test_a_variant_may_only_use_allowed_models(client: TestClient) -> None:
    response = client.post(
        "/pipelines/test",
        json={
            "definition": _definition(TESTS),
            "variants": [
                {
                    "label": "x",
                    "models": {"answer": {"provider": "ollama", "model": "not-installed"}},
                }
            ],
        },
    )
    assert response.status_code == 422
    assert response.json()["code"] == "MODEL_NOT_ALLOWED"
    assert "not-installed" in response.json()["message"]


def test_test_run_problems(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    nothing = client.post("/pipelines/test", json={"definition": _definition()})
    assert nothing.status_code == 400
    assert nothing.json()["code"] == "REQUEST_INVALID"
    unknown = client.post(
        "/pipelines/test", json={"definition": _definition(TESTS), "cases": ["nope"]}
    )
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "TEST_CASE_NOT_FOUND"
    same_label = client.post(
        "/pipelines/test",
        json={
            "definition": _definition(TESTS),
            "variants": [
                {"label": "current", "models": {"answer": {"provider": "ollama", "model": "small"}}}
            ],
        },
    )
    assert same_label.status_code == 400
    assert same_label.json()["code"] == "REQUEST_INVALID"
    no_node = client.post(
        "/pipelines/test",
        json={
            "definition": _definition(TESTS),
            "variants": [
                {"label": "v", "models": {"ghost": {"provider": "ollama", "model": "small"}}}
            ],
        },
    )
    assert no_node.status_code == 422
    assert no_node.json()["code"] == "DEFINITION_INVALID"
    monkeypatch.setattr(settings, "pipeline_editing_enabled", False)
    assert (
        client.post("/pipelines/test", json={"definition": _definition(TESTS)}).status_code == 403
    )


def test_a_failing_run_is_reported_per_case(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Down:
        async def generate(self, prompt: str, system: str | None = None) -> str:
            raise ConnectionError("ollama down")

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _Down())
    definition = _definition({"cases": [{"name": "a", "input": "x"}]})
    definition["execution"] = {"max_retries": 0}
    events = _events(client.post("/pipelines/test", json={"definition": definition}).text)
    result = next(d for kind, d in events if kind == "case_result")
    assert result["passed"] is False and "ollama down" in result["error"]
    assert events[-1][1]["summaries"][0]["errors"] == 1


@pytest.mark.asyncio
async def test_a_check_can_read_the_question() -> None:
    expectation = EvalExpectation(check='"order" in question and output.contains("42")')
    result = await check_expectation(
        expectation, "where is order 42?", "Order 42 ships today", None
    )
    assert result.passed
