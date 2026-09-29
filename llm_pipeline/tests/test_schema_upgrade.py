"""Version 1 of the pipeline schema called three things differently
(pipeline_config/upgrade.py). Its keys are still read — from files and
request bodies — and everything is written as version 2."""

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient
from pydantic import ValidationError

import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.main import app
from llm_pipeline.model_catalog import CatalogModel, ModelCatalog
from llm_pipeline.pipeline_config import NodePreset, PipelineDefinition, load_pipeline_definition
from llm_pipeline.settings import settings

VERSION_1: dict[str, Any] = {
    "name": "p",
    "version": 1,
    "execution": {"model_timeout_seconds": 30, "max_history_turns": 4},
    "defaults": {"model": {"provider": "ollama", "model": "llama3"}},
    "history": {"summarize": {"model": {"provider": "ollama", "model": "small"}}},
    "nodes": [
        {"id": "a", "prompt_template": "{{ message }}"},
        {
            "id": "b",
            "depends_on": ["a"],
            "model": {"provider": "ollama", "model": "big", "temperature": 0.1},
            "prompt_template": "{{ a.output }}",
        },
    ],
    "output_node": "b",
    "tests": {"judge": {"model": {"provider": "ollama", "model": "judge"}}},
}

VERSION_2: dict[str, Any] = {
    "name": "p",
    "version": 2,
    "execution": {"model_timeout_seconds": 30},
    "defaults": {"model": {"provider": "ollama", "name": "llama3"}},
    "history": {"max_turns": 4, "summarize": {"model": {"provider": "ollama", "name": "small"}}},
    "nodes": [
        {"id": "a", "prompt_template": "{{ message }}"},
        {
            "id": "b",
            "depends_on": ["a"],
            "model": {"provider": "ollama", "name": "big", "temperature": 0.1},
            "prompt_template": "{{ a.output }}",
        },
    ],
    "output_nodes": ["b"],
    "tests": {"judge": {"model": {"provider": "ollama", "name": "judge"}}},
}


def test_version_1_keys_mean_the_same_as_version_2() -> None:
    old = PipelineDefinition.model_validate(VERSION_1)
    assert old == PipelineDefinition.model_validate(VERSION_2)
    assert old.version == 2
    assert VERSION_1["output_node"] == "b", "the caller's input isn't changed"
    listed = PipelineDefinition.model_validate({**VERSION_1, "output_node": ["b", "a"]})
    assert listed.output_nodes == ["b", "a"]


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"output_nodes": ["b"]}, "'output_node' is the version-1 name of 'output_nodes'"),
        (
            {"history": {"max_turns": 2}},
            "'execution.max_history_turns' is the version-1 name of 'history.max_turns'",
        ),
        (
            {"defaults": {"model": {"provider": "ollama", "model": "x", "name": "y"}}},
            "'model' is the version-1 name of 'name'",
        ),
    ],
)
def test_a_key_and_its_version_1_name_cannot_both_be_set(
    change: dict[str, Any], message: str
) -> None:
    with pytest.raises(ValidationError, match=message):
        PipelineDefinition.model_validate({**VERSION_1, **change})


@pytest.mark.parametrize("version", [0, 3])
def test_unknown_versions_are_refused(version: int) -> None:
    with pytest.raises(ValidationError, match=f"version {version} is not one this server reads"):
        PipelineDefinition.model_validate({**VERSION_2, "version": version})


def test_a_version_1_preset_is_read() -> None:
    preset = NodePreset.model_validate(
        {"name": "x", "model": {"provider": "ollama", "model": "llama3"}}
    )
    assert preset.model.name == "llama3"


# -- over the API, and on disk ---------------------------------------------------------

COMMENTED_VERSION_1 = """\
name: old
version: 1

execution:
  model_timeout_seconds: 60
  max_history_turns: 4  # short memory

nodes:
  # the only node
  - id: answer
    model: { provider: ollama, model: llama3 }  # fast (the comment keeps its column)
    prompt_template: "{{ input }}"

output_node: answer  # what the user sees
"""


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    (tmp_path / "pipelines").mkdir()
    (tmp_path / "pipelines" / "old.yaml").write_text(COMMENTED_VERSION_1)
    monkeypatch.setattr(settings, "pipelines_dir", str(tmp_path / "pipelines"))
    monkeypatch.setattr(settings, "presets_dir", str(tmp_path / "presets"))
    monkeypatch.setattr(settings, "default_pipeline_name", "old")
    monkeypatch.setattr(settings, "pipeline_editing_enabled", True)
    monkeypatch.setattr(settings, "api_keys", "")
    monkeypatch.setattr(settings, "cors_allowed_origins", "http://localhost:5173")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))

    async def installed() -> list[CatalogModel]:
        return [CatalogModel(name=name) for name in ("llama3:latest", "small:latest")]

    with TestClient(app, raise_server_exceptions=False) as c:
        c.app.state.pipeline_store.catalog = ModelCatalog(  # type: ignore[attr-defined]
            "http://ollama.test", [], fetch_ollama_models=installed
        )
        yield c


def test_a_version_1_body_is_accepted_and_answered_in_version_2(client: TestClient) -> None:
    body = client.post(
        "/drafts/validation", json={"format": "json", "definition": VERSION_1}
    ).json()
    assert body["definition"]["output_nodes"] == ["b"]
    assert body["definition"]["nodes"][1]["model"]["name"] == "big"
    assert body["definition"]["history"]["max_turns"] == 4
    written = yaml.safe_load(body["yaml"])
    assert written["version"] == 2 and "output_node" not in written


def test_saving_a_version_1_file_upgrades_it_and_keeps_its_comments(
    client: TestClient, tmp_path: Path
) -> None:
    loaded = client.get("/pipelines/old").json()
    assert loaded["definition"]["output_nodes"] == ["answer"]
    saved = client.put(
        "/pipelines/old",
        json={"definition": loaded["definition"]},
        headers={"If-Match": f'"{loaded["revision"]}"'},
    ).json()
    assert saved["comments_preserved"] is True
    path = tmp_path / "pipelines" / "old.yaml"
    assert (
        path.read_text()
        == """\
name: old
version: 2

execution:
  model_timeout_seconds: 60
history:
  max_turns: 4  # short memory

nodes:
  # the only node
  - id: answer
    model: { provider: ollama, name: llama3 }   # fast (the comment keeps its column)
    prompt_template: "{{ input }}"

output_nodes: [answer]  # what the user sees
"""
    )
    assert load_pipeline_definition(path).history.max_turns == 4


def test_saving_a_version_1_preset_upgrades_it_and_keeps_its_comments(
    client: TestClient, tmp_path: Path
) -> None:
    path = tmp_path / "presets" / "fast.yaml"
    path.parent.mkdir()
    path.write_text("# for quick drafts\nname: fast\nmodel:\n  provider: ollama\n  model: llama3\n")
    preset = client.get("/presets/fast").json()["preset"]
    preset["model"]["temperature"] = 0.5
    client.put("/presets/fast", json={"preset": preset})
    assert path.read_text() == (
        "# for quick drafts\nname: fast\nmodel:\n  provider: ollama\n  name: llama3\n"
        "  temperature: 0.5\n"
    )
