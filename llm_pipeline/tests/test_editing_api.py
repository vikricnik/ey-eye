"""Editor endpoints: full definitions, validate/import/export, saving,
presets, the model allowlist — and that nothing is ever written unless a
definition passes all of it."""

import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import yaml
from fastapi.testclient import TestClient

import llm_pipeline.dag_builder.node_types as node_types_module
import llm_pipeline.rate_limit as rate_limit_module
from llm_pipeline.main import app
from llm_pipeline.model_catalog import CatalogModel, ModelCatalog, ModelLimits
from llm_pipeline.pipeline_config import load_pipeline_definition
from llm_pipeline.pipeline_loader import PipelineCache
from llm_pipeline.pipeline_store import definition_to_yaml, parse_definition_yaml
from llm_pipeline.settings import settings

SHIPPED_PIPELINES = Path(__file__).parent.parent / "pipelines"
INSTALLED = ["llama3:latest", "gemma3:12b", "qwen3-coder:30b", "llama3.2:3b"]


async def _installed_models() -> list[CatalogModel]:
    return [CatalogModel(name=name) for name in INSTALLED]


async def _ollama_down() -> list[CatalogModel]:
    raise ConnectionError("connection refused")


async def _show(name: str) -> ModelLimits:
    if name.split(":")[0] not in {"llama3", "gemma3"}:
        raise LookupError(f"model '{name}' not found")
    return ModelLimits(
        name=name, context_length=8192, parameter_size="8.0B", quantization="Q4_0", family="llama"
    )


@pytest.fixture
def dirs(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    pipelines = tmp_path / "pipelines"
    presets = tmp_path / "presets"
    shutil.copytree(SHIPPED_PIPELINES, pipelines)
    monkeypatch.setattr(settings, "pipelines_dir", str(pipelines))
    monkeypatch.setattr(settings, "presets_dir", str(presets))
    monkeypatch.setattr(settings, "pipeline_editing_enabled", True)
    monkeypatch.setattr(settings, "api_keys", "")
    # Explicit origins: with "*" and no API key, editing is refused (see
    # test_wildcard_cors_without_api_key_blocks_editing).
    monkeypatch.setattr(settings, "cors_allowed_origins", "http://localhost:5173")
    monkeypatch.setattr(settings, "editor_cloud_models", "openai:gpt-4o")
    monkeypatch.setattr(rate_limit_module, "_limiter", rate_limit_module.RateLimiter(1000))
    return pipelines, presets


def _use_catalog(client: TestClient, lister: Any = _installed_models, shower: Any = _show) -> None:
    client.app.state.pipeline_store.catalog = ModelCatalog(  # type: ignore[attr-defined]
        ollama_base_url="http://ollama.test",
        cloud_models=settings.editor_cloud_models_list,
        ollama_lister=lister,
        ollama_shower=shower,
    )


@pytest.fixture
def client(dirs: tuple[Path, Path]) -> Iterator[TestClient]:
    with TestClient(app, raise_server_exceptions=False) as c:
        _use_catalog(c)
        yield c


def _pipeline(name: str = "fresh", model: str = "llama3", **node: Any) -> dict[str, Any]:
    first: dict[str, Any] = {
        "id": "draft",
        "depends_on": [],
        "model": {"provider": "ollama", "model": model, "temperature": 0.4},
        "prompt_template": "Draft an answer to: {{ input }}",
    }
    first.update(node)
    return {
        "name": name,
        "nodes": [
            first,
            {
                "id": "polish",
                "depends_on": ["draft"],
                "model": {"provider": "ollama", "model": "gemma3:12b"},
                "system_prompt": "You are an editor.",
                "prompt_template": "Polish this:\n{{ draft.output }}\n",
                "layout": {"x": 300, "y": 40},
            },
        ],
        "output_node": "polish",
    }


# -- gates -----------------------------------------------------------------


def test_saving_is_forbidden_when_editing_is_disabled(
    client: TestClient, dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "pipeline_editing_enabled", False)
    response = client.put("/pipelines/fresh", json={"definition": _pipeline()})
    assert response.status_code == 403
    assert response.json()["code"] == "EDITING_DISABLED"
    assert "PIPELINE_EDITING_ENABLED" in response.json()["message"]
    assert not (dirs[0] / "fresh.yaml").exists()
    # Reads and validation stay available.
    assert client.post("/pipelines/validate", json={"definition": _pipeline()}).status_code == 200
    assert client.get("/health").json()["editing_enabled"] is False


def test_editing_endpoints_require_an_api_key_when_auth_is_on(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "api_keys", "secret")
    assert client.put("/pipelines/fresh", json={"definition": _pipeline()}).status_code == 401
    assert client.get("/models").status_code == 401
    assert client.get("/presets").status_code == 401
    ok = client.put(
        "/pipelines/fresh", json={"definition": _pipeline()}, headers={"X-API-Key": "secret"}
    )
    assert ok.status_code == 200


def test_wildcard_cors_without_api_key_blocks_editing(
    client: TestClient, dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Any web page the user visits could otherwise send writes to a local
    server from their browser — so this combination fails closed."""
    monkeypatch.setattr(settings, "cors_allowed_origins", "*")
    response = client.put("/pipelines/fresh", json={"definition": _pipeline()})
    assert response.status_code == 403
    assert response.json()["code"] == "EDITING_DISABLED"
    assert "CORS_ALLOWED_ORIGINS" in response.json()["message"]
    assert not (dirs[0] / "fresh.yaml").exists()

    health = client.get("/health").json()
    assert health["editing_enabled"] is False
    assert "API_KEYS" in health["editing_disabled_reason"]


def test_wildcard_cors_is_fine_once_an_api_key_is_required(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "cors_allowed_origins", "*")
    monkeypatch.setattr(settings, "api_keys", "secret")
    response = client.put(
        "/pipelines/fresh", json={"definition": _pipeline()}, headers={"X-API-Key": "secret"}
    )
    assert response.status_code == 200
    health = client.get("/health").json()
    assert health["editing_enabled"] is True
    assert health["editing_disabled_reason"] is None


def test_explicit_origins_allow_editing_without_a_key(client: TestClient) -> None:
    assert client.put("/pipelines/fresh", json={"definition": _pipeline()}).status_code == 200
    assert client.get("/health").json()["editing_enabled"] is True


# -- reading ---------------------------------------------------------------


def test_full_definition_includes_prompts_revision_and_comment_flag(client: TestClient) -> None:
    response = client.get("/pipelines/consensus-qa/definition")
    assert response.status_code == 200
    body = response.json()
    assert body["has_comments"] is True  # the shipped file is heavily commented
    assert len(body["revision"]) == 16
    nodes = {n["id"]: n for n in body["definition"]["nodes"]}
    assert "{{ input }}" in nodes["answer_local"]["prompt_template"]
    assert nodes["reconcile"]["model"] == {
        "provider": "ollama",
        "model": "llama3",
        "temperature": 0.0,
    }


def test_full_definition_uses_the_from_alias_for_branches(client: TestClient) -> None:
    body = client.get("/pipelines/support-router/definition").json()
    assert "from" in body["definition"]["branches"][0]


@pytest.mark.parametrize("name", ["missing", "..%2F..%2Fetc%2Fpasswd", "a.b"])
def test_unknown_or_unsafe_names_are_404(client: TestClient, name: str) -> None:
    assert client.get(f"/pipelines/{name}/definition").status_code == 404


def test_models_lists_installed_ollama_models_and_cloud_allowlist(client: TestClient) -> None:
    providers = {p["provider"]: p for p in client.get("/models").json()["providers"]}
    assert providers["ollama"]["reachable"] is True
    assert [m["name"] for m in providers["ollama"]["models"]] == INSTALLED
    assert [m["name"] for m in providers["openai"]["models"]] == ["gpt-4o"]


def test_models_reports_unreachable_ollama_without_failing(client: TestClient) -> None:
    _use_catalog(client, _ollama_down)
    body = client.get("/models").json()
    ollama = body["providers"][0]
    assert ollama["reachable"] is False and ollama["models"] == []
    assert "unreachable" in ollama["error"]


# -- validate / import / export ----------------------------------------------


def test_validate_returns_canonical_yaml_that_round_trips(client: TestClient) -> None:
    response = client.post("/pipelines/validate", json={"definition": _pipeline()})
    assert response.status_code == 200
    body = response.json()
    assert body["model_issues"] == []
    reloaded = client.post("/pipelines/validate", json={"yaml": body["yaml"]}).json()
    assert reloaded["definition"] == body["definition"]
    # Multi-line prompts are written as literal blocks.
    assert "prompt_template: |" in body["yaml"]


def test_validate_names_the_offending_node(client: TestClient) -> None:
    broken = _pipeline()
    broken["nodes"][1]["prompt_template"] = "{{ nowhere.output }}"
    response = client.post("/pipelines/validate", json={"definition": broken})
    assert response.status_code == 422
    body = response.json()
    assert body["details"] == {"node_id": "polish"}
    assert "nowhere" in body["message"]


def test_validate_maps_field_errors_to_their_node(client: TestClient) -> None:
    broken = _pipeline()
    broken["nodes"][1]["model"]["temperature"] = 9
    body = client.post("/pipelines/validate", json={"definition": broken}).json()
    assert body["details"] == {"node_id": "polish"}
    assert body["validations"][0]["field"] == "nodes.1.model.temperature"


def test_validate_reports_model_issues_as_warnings(client: TestClient) -> None:
    body = client.post(
        "/pipelines/validate", json={"definition": _pipeline(model="not-pulled")}
    ).json()
    assert body["model_issues"] == [
        {
            "node_id": "draft",
            "message": (
                "node 'draft': Ollama model 'not-pulled' is not installed on "
                "http://ollama.test (run `ollama pull not-pulled` first)"
            ),
        }
    ]


def test_validate_rejects_bad_yaml_and_needs_exactly_one_input(client: TestClient) -> None:
    assert client.post("/pipelines/validate", json={"yaml": "nodes: [unclosed"}).status_code == 422
    assert client.post("/pipelines/validate", json={}).status_code == 422
    both = {"definition": _pipeline(), "yaml": "x: 1"}
    assert client.post("/pipelines/validate", json=both).status_code == 422


# -- saving ------------------------------------------------------------------


def test_create_writes_the_file_and_runs_use_it_immediately(
    client: TestClient, dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    response = client.put("/pipelines/fresh", json={"definition": _pipeline()})
    assert response.status_code == 200
    path = dirs[0] / "fresh.yaml"
    on_disk = yaml.safe_load(path.read_text())
    assert on_disk["name"] == "fresh"
    assert on_disk["nodes"][1]["system_prompt"] == "You are an editor."
    assert on_disk["nodes"][1]["layout"] == {"x": 300.0, "y": 40.0}
    assert "type" not in on_disk["nodes"][0]  # defaults stay out of the file
    assert (
        response.json()["revision"] == client.get("/pipelines/fresh/definition").json()["revision"]
    )

    class _Echo:
        async def generate(self, prompt: str, system: str | None = None) -> str:
            return f"<{system}>{prompt}"

    monkeypatch.setattr(node_types_module, "get_provider", lambda spec: _Echo())
    answer = client.post("/ask", json={"prompt": "hi", "pipeline_name": "fresh"}).json()
    assert answer["final_answer"].startswith("<You are an editor.>Polish this:")


def test_invalid_definition_is_rejected_and_nothing_is_written(
    client: TestClient, dirs: tuple[Path, Path]
) -> None:
    cyclic = _pipeline()
    cyclic["nodes"][0]["depends_on"] = ["polish"]
    response = client.put("/pipelines/fresh", json={"definition": cyclic})
    assert response.status_code == 422
    assert response.json()["code"] == "DEFINITION_INVALID"
    assert "cycle" in response.json()["message"]
    assert not (dirs[0] / "fresh.yaml").exists()
    assert list(dirs[0].glob(".*.tmp")) == []


def test_disallowed_models_are_rejected_and_nothing_is_written(
    client: TestClient, dirs: tuple[Path, Path]
) -> None:
    response = client.put("/pipelines/fresh", json={"definition": _pipeline(model="evil:latest")})
    assert response.status_code == 422
    assert response.json()["code"] == "MODEL_NOT_ALLOWED"
    assert response.json()["details"] == {"node_id": "draft"}

    cloud = _pipeline()
    cloud["nodes"][0]["model"] = {"provider": "anthropic", "model": "claude-x"}
    response = client.put("/pipelines/fresh", json={"definition": cloud})
    assert response.status_code == 422
    assert "EDITOR_CLOUD_MODELS" in response.json()["message"]

    allowed_cloud = _pipeline()
    allowed_cloud["nodes"][0]["model"] = {"provider": "openai", "model": "gpt-4o"}
    assert client.put("/pipelines/fresh", json={"definition": allowed_cloud}).status_code == 200


def test_unreachable_ollama_fails_closed(client: TestClient, dirs: tuple[Path, Path]) -> None:
    _use_catalog(client, _ollama_down)
    response = client.put("/pipelines/fresh", json={"definition": _pipeline()})
    assert response.status_code == 422
    assert "can't verify" in response.json()["message"]
    assert not (dirs[0] / "fresh.yaml").exists()


def test_models_already_in_the_stored_pipeline_can_be_resaved(client: TestClient) -> None:
    """consensus-qa uses llama3/gemma3/qwen3-coder. Even with Ollama down,
    editing only a prompt re-saves identities that were already on the
    server — that's not new client input."""
    loaded = client.get("/pipelines/consensus-qa/definition").json()
    _use_catalog(client, _ollama_down)
    definition = loaded["definition"]
    definition["nodes"][0]["prompt_template"] = "Answer briefly: {{ input }}"
    response = client.put(
        "/pipelines/consensus-qa",
        json={"definition": definition, "base_revision": loaded["revision"]},
    )
    assert response.status_code == 200, response.json()


def test_create_refuses_to_overwrite_and_stale_revisions_conflict(client: TestClient) -> None:
    created = client.put("/pipelines/fresh", json={"definition": _pipeline()}).json()
    again = client.put("/pipelines/fresh", json={"definition": _pipeline()})
    assert again.status_code == 409
    assert again.json()["code"] == "PIPELINE_EXISTS"
    assert "already exists" in again.json()["message"]

    edited = _pipeline()
    edited["nodes"][0]["model"]["temperature"] = 0.9
    first = client.put(
        "/pipelines/fresh", json={"definition": edited, "base_revision": created["revision"]}
    )
    assert first.status_code == 200
    stale = client.put(
        "/pipelines/fresh", json={"definition": edited, "base_revision": created["revision"]}
    )
    assert stale.status_code == 409
    assert stale.json()["code"] == "REVISION_CONFLICT"
    assert "changed since you loaded it" in stale.json()["message"]


@pytest.mark.parametrize("name", ["..", "bad name", "a.b"])
def test_unsafe_names_are_rejected_on_save(client: TestClient, name: str) -> None:
    response = client.put(f"/pipelines/{name}", json={"definition": _pipeline(name=name)})
    assert response.status_code in (400, 404, 405)


def test_path_traversal_name_is_rejected_on_save(
    client: TestClient, dirs: tuple[Path, Path]
) -> None:
    response = client.put("/pipelines/..%2Fescape", json={"definition": _pipeline(name="x")})
    assert response.status_code in (400, 404)
    assert not (dirs[0].parent / "escape.yaml").exists()


def test_a_name_with_a_trailing_newline_is_not_saved(
    client: TestClient, dirs: tuple[Path, Path]
) -> None:
    response = client.put("/pipelines/demo%0A", json={"definition": _pipeline(name="demo\n")})
    assert 400 <= response.status_code < 500
    assert list(dirs[0].glob("demo*")) == []


def test_name_in_url_must_match_the_definition(client: TestClient) -> None:
    response = client.put("/pipelines/other", json={"definition": _pipeline(name="fresh")})
    assert response.status_code == 422
    assert "must match" in response.json()["message"]


# -- round trip + cache --------------------------------------------------------


@pytest.mark.parametrize("path", sorted(SHIPPED_PIPELINES.glob("*.yaml")), ids=lambda p: p.name)
def test_every_shipped_pipeline_round_trips_through_canonical_yaml(path: Path) -> None:
    definition = load_pipeline_definition(path)
    assert parse_definition_yaml(definition_to_yaml(definition)) == definition


def test_cache_reloads_when_the_file_changes(tmp_path: Path) -> None:
    # Its own file, not a shipped one: those are the user's to edit.
    path = tmp_path / "fresh.yaml"
    path.write_text(yaml.safe_dump(_pipeline(), sort_keys=False))
    cache = PipelineCache(tmp_path)
    first, _ = cache.get("fresh")
    assert first.nodes[0].model is not None and first.nodes[0].model.temperature == 0.4

    path.write_text(path.read_text().replace("temperature: 0.4", "temperature: 0.75"))
    second, _ = cache.get("fresh")
    assert second.nodes[0].model is not None and second.nodes[0].model.temperature == 0.75

    path.unlink()
    with pytest.raises(Exception, match="No pipeline named"):
        cache.get("simple-local")


# -- presets -----------------------------------------------------------------


def _preset(name: str = "terse-llama", model: str = "llama3") -> dict[str, Any]:
    return {
        "name": name,
        "description": "Short factual answers",
        "model": {
            "provider": "ollama",
            "model": model,
            "temperature": 0.1,
            "options": {"num_ctx": 4096, "top_p": 0.8},
        },
        "system_prompt": "Answer in one sentence.",
    }


def test_presets_can_be_saved_listed_and_read(client: TestClient, dirs: tuple[Path, Path]) -> None:
    assert client.get("/presets").json() == {"presets": []}
    saved = client.put("/presets/terse-llama", json={"preset": _preset()})
    assert saved.status_code == 200
    assert (dirs[1] / "terse-llama.yaml").is_file()

    listed = client.get("/presets").json()["presets"]
    assert [p["name"] for p in listed] == ["terse-llama"]
    one = client.get("/presets/terse-llama").json()
    assert one["preset"]["model"]["options"] == {"num_ctx": 4096, "top_p": 0.8}

    updated = _preset()
    updated["model"]["temperature"] = 0.3
    assert client.put("/presets/terse-llama", json={"preset": updated}).status_code == 200
    assert client.get("/presets/terse-llama").json()["preset"]["model"]["temperature"] == 0.3


def test_presets_validate_and_allowlist_their_model(
    client: TestClient, dirs: tuple[Path, Path]
) -> None:
    missing = client.get("/presets/missing")
    assert missing.status_code == 404
    assert missing.json()["code"] == "PRESET_NOT_FOUND"
    evil = _preset(name="p", model="evil")
    assert client.put("/presets/p", json={"preset": evil}).status_code == 422
    bad = _preset(name="p")
    bad["model"]["options"]["bogus"] = 1
    assert client.put("/presets/p", json={"preset": bad}).status_code == 422
    assert client.put("/presets/q", json={"preset": _preset(name="p")}).status_code == 422
    assert not (dirs[1] / "p.yaml").exists()


def test_a_preset_keeps_a_whole_node_configuration(
    client: TestClient, dirs: tuple[Path, Path]
) -> None:
    """The node library: prompt, history and reasoning settings travel with
    the model; `include_history: true` is the default and isn't written."""
    whole = {
        **_preset(),
        "prompt_template": "Critique this:\n\n{{ draft.output }}",
        "include_history": False,
        "strip_reasoning": True,
    }
    assert client.put("/presets/terse-llama", json={"preset": whole}).status_code == 200
    back = client.get("/presets/terse-llama").json()["preset"]
    assert back["include_history"] is False and back["strip_reasoning"] is True
    assert back["prompt_template"] == whole["prompt_template"]

    sees_history = {**_preset(), "include_history": True}
    assert client.put("/presets/terse-llama", json={"preset": sees_history}).status_code == 200
    assert "include_history" not in (dirs[1] / "terse-llama.yaml").read_text()


def test_a_preset_prompt_must_parse(client: TestClient, dirs: tuple[Path, Path]) -> None:
    broken = {**_preset(name="p"), "prompt_template": "{{ input "}
    response = client.put("/presets/p", json={"preset": broken})
    assert response.status_code == 422
    assert "invalid template syntax" in response.text
    assert not (dirs[1] / "p.yaml").exists()


# -- deleting ----------------------------------------------------------------


def test_delete_moves_the_file_aside_and_drops_it_from_listings(
    client: TestClient, dirs: tuple[Path, Path]
) -> None:
    created = client.put("/pipelines/fresh", json={"definition": _pipeline()}).json()
    response = client.delete(f"/pipelines/fresh?revision={created['revision']}")
    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "fresh"
    assert body["recoverable_as"].startswith(".deleted/fresh.")

    assert not (dirs[0] / "fresh.yaml").exists()
    assert (dirs[0] / body["recoverable_as"]).is_file()  # recoverable
    names = [p["name"] for p in client.get("/pipelines").json()["pipelines"]]
    assert "fresh" not in names
    assert client.get("/pipelines/fresh/definition").status_code == 404
    assert client.post("/ask", json={"prompt": "x", "pipeline_name": "fresh"}).status_code == 404


def test_delete_refuses_the_default_pipeline_stale_revisions_and_unknown_names(
    client: TestClient, dirs: tuple[Path, Path]
) -> None:
    default = settings.default_pipeline_name
    refused = client.delete(f"/pipelines/{default}")
    assert refused.status_code == 409
    assert refused.json()["code"] == "PIPELINE_PROTECTED"
    assert "default pipeline" in refused.json()["message"]
    assert (dirs[0] / f"{default}.yaml").is_file()

    client.put("/pipelines/fresh", json={"definition": _pipeline()})
    stale = client.delete("/pipelines/fresh?revision=0000000000000000")
    assert stale.status_code == 409
    assert stale.json()["code"] == "REVISION_CONFLICT"
    assert (dirs[0] / "fresh.yaml").is_file()

    missing = client.delete("/pipelines/missing")
    assert missing.status_code == 404
    assert missing.json()["code"] == "PIPELINE_NOT_FOUND"
    bad_name = client.delete("/pipelines/bad%20name")
    assert bad_name.status_code == 400
    assert bad_name.json()["code"] == "NAME_INVALID"


def test_delete_needs_editing_enabled(
    client: TestClient, dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    client.put("/pipelines/fresh", json={"definition": _pipeline()})
    monkeypatch.setattr(settings, "pipeline_editing_enabled", False)
    assert client.delete("/pipelines/fresh").status_code == 403
    assert client.delete("/presets/anything").status_code == 403
    assert (dirs[0] / "fresh.yaml").is_file()


def test_presets_can_be_deleted(client: TestClient, dirs: tuple[Path, Path]) -> None:
    client.put("/presets/terse-llama", json={"preset": _preset()})
    response = client.delete("/presets/terse-llama")
    assert response.status_code == 200
    assert not (dirs[1] / "terse-llama.yaml").exists()
    assert (dirs[1] / response.json()["recoverable_as"]).is_file()
    assert client.get("/presets").json() == {"presets": []}
    assert client.delete("/presets/terse-llama").status_code == 404


# -- keeping comments ----------------------------------------------------------


def _changed_lines(before: str, after: str) -> list[str]:
    import difflib

    return [
        line
        for line in difflib.unified_diff(before.splitlines(), after.splitlines(), lineterm="", n=0)
        if line[:1] in "+-" and not line.startswith(("+++", "---"))
    ]


def _comment_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip().startswith("#")]


@pytest.mark.parametrize("name", sorted(p.stem for p in SHIPPED_PIPELINES.glob("*.yaml")))
def test_saving_unchanged_keeps_the_file_byte_identical(
    client: TestClient, dirs: tuple[Path, Path], name: str
) -> None:
    path = dirs[0] / f"{name}.yaml"
    before = path.read_text()
    loaded = client.get(f"/pipelines/{name}/definition").json()
    saved = client.put(
        f"/pipelines/{name}",
        json={"definition": loaded["definition"], "base_revision": loaded["revision"]},
    ).json()
    assert saved["comments_preserved"] is True
    assert path.read_text() == before


def test_editing_one_prompt_changes_only_that_line(
    client: TestClient, dirs: tuple[Path, Path]
) -> None:
    path = dirs[0] / "consensus-qa.yaml"
    before = path.read_text()
    loaded = client.get("/pipelines/consensus-qa/definition").json()
    definition = loaded["definition"]
    definition["nodes"][0]["prompt_template"] = "Answer briefly: {{ input }}"
    saved = client.put(
        "/pipelines/consensus-qa",
        json={"definition": definition, "base_revision": loaded["revision"]},
    ).json()

    after = path.read_text()
    assert saved["comments_preserved"] is True
    assert _changed_lines(before, after) == [
        '-    prompt_template: "Answer this question accurately and concisely: {{ input }}"',
        '+    prompt_template: "Answer briefly: {{ input }}"',
    ]
    assert load_pipeline_definition(path).nodes[0].prompt_template == "Answer briefly: {{ input }}"


def test_structural_edits_keep_every_other_comment(
    client: TestClient, dirs: tuple[Path, Path]
) -> None:
    path = dirs[0] / "consensus-qa.yaml"
    before = path.read_text()
    loaded = client.get("/pipelines/consensus-qa/definition").json()
    definition = loaded["definition"]
    # Change a setting the file leaves implicit, add a node, add Ollama options.
    definition["execution"]["max_retries"] = 3
    definition["nodes"][3]["model"]["options"] = {"num_ctx": 8192}
    definition["nodes"].append(
        {
            "id": "audit",
            "depends_on": ["reconcile"],
            "model": {"provider": "ollama", "model": "llama3"},
            "prompt_template": "Check this:\n{{ reconcile.output }}\n",
        }
    )
    saved = client.put(
        "/pipelines/consensus-qa",
        json={"definition": definition, "base_revision": loaded["revision"]},
    ).json()
    after = path.read_text()

    assert saved["comments_preserved"] is True
    assert _comment_lines(after) == _comment_lines(before)
    stored = load_pipeline_definition(path)
    assert stored.execution.max_retries == 3
    assert stored.nodes[3].model is not None and stored.nodes[3].model.options is not None
    assert stored.nodes[-1].id == "audit"
    # Only what changed is spelled out: the unchanged implicit default isn't.
    assert "retry_backoff_seconds" not in after
    assert "type: llm_call" not in after
    assert "prompt_template: |" in after  # new multi-line prompt as a literal block

    # Removing a node keeps the comments of the nodes that remain.
    loaded = client.get("/pipelines/consensus-qa/definition").json()
    definition = loaded["definition"]
    definition["nodes"] = [n for n in definition["nodes"] if n["id"] != "audit"]
    client.put(
        "/pipelines/consensus-qa",
        json={"definition": definition, "base_revision": loaded["revision"]},
    )
    assert _comment_lines(path.read_text()) == _comment_lines(before)


def test_falls_back_to_canonical_when_the_merge_would_change_meaning(
    client: TestClient, dirs: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    import llm_pipeline.pipeline_store as store_module

    monkeypatch.setattr(
        store_module, "_preserving_yaml", lambda original, old_full, full, canon: original
    )
    path = dirs[0] / "consensus-qa.yaml"
    loaded = client.get("/pipelines/consensus-qa/definition").json()
    definition = loaded["definition"]
    definition["nodes"][0]["prompt_template"] = "Changed: {{ input }}"
    saved = client.put(
        "/pipelines/consensus-qa",
        json={"definition": definition, "base_revision": loaded["revision"]},
    ).json()

    assert saved["comments_preserved"] is False
    assert _comment_lines(path.read_text()) == []
    assert load_pipeline_definition(path).nodes[0].prompt_template == "Changed: {{ input }}"


def test_preset_comments_survive_a_save(client: TestClient, dirs: tuple[Path, Path]) -> None:
    client.put("/presets/terse-llama", json={"preset": _preset()})
    path = dirs[1] / "terse-llama.yaml"
    path.write_text("# my favourite settings\n" + path.read_text())
    updated = _preset()
    updated["model"]["temperature"] = 0.5
    client.put("/presets/terse-llama", json={"preset": updated})
    text = path.read_text()
    assert text.startswith("# my favourite settings\n")
    assert "temperature: 0.5" in text


# -- model limits ----------------------------------------------------------------


def test_model_limits_endpoint(client: TestClient) -> None:
    body = client.get("/models/ollama/llama3:latest").json()
    assert body == {
        "name": "llama3:latest",
        "context_length": 8192,
        "parameter_size": "8.0B",
        "quantization": "Q4_0",
        "family": "llama",
    }
    # Names with a namespace contain '/', which the route accepts.
    unknown = client.get("/models/ollama/someone/unknown:7b")
    assert unknown.status_code == 404
    assert unknown.json()["code"] == "MODEL_NOT_FOUND"


def test_validate_warns_when_num_ctx_exceeds_the_model_maximum(client: TestClient) -> None:
    too_big = _pipeline()
    too_big["nodes"][0]["model"]["options"] = {"num_ctx": 32768}
    body = client.post("/pipelines/validate", json={"definition": too_big}).json()
    assert body["warnings"] == [
        {
            "node_id": "draft",
            "message": (
                "node 'draft': num_ctx 32,768 exceeds llama3's maximum context of 8,192 tokens"
            ),
        }
    ]
    fits = _pipeline()
    fits["nodes"][0]["model"]["options"] = {"num_ctx": 4096}
    assert client.post("/pipelines/validate", json={"definition": fits}).json()["warnings"] == []
    # A warning never blocks saving.
    assert client.put("/pipelines/fresh", json={"definition": too_big}).status_code == 200


def test_limits_are_best_effort_when_ollama_is_down(client: TestClient) -> None:
    async def down(name: str) -> ModelLimits:
        raise ConnectionError("connection refused")

    _use_catalog(client, shower=down)
    too_big = _pipeline()
    too_big["nodes"][0]["model"]["options"] = {"num_ctx": 32768}
    response = client.post("/pipelines/validate", json={"definition": too_big})
    assert response.status_code == 200
    assert response.json()["warnings"] == []
    assert client.get("/models/ollama/llama3").status_code == 404


@pytest.mark.asyncio
async def test_real_show_response_is_parsed(monkeypatch: pytest.MonkeyPatch) -> None:
    """The default shower reads `<architecture>.context_length` from the
    model_info Ollama returns."""
    import ollama
    from ollama import ShowResponse

    class _FakeClient:
        def __init__(self, host: str) -> None:
            pass

        async def show(self, model: str) -> ShowResponse:
            return ShowResponse.model_validate(
                {
                    "model_info": {"general.architecture": "llama", "llama.context_length": 131072},
                    "details": {"parameter_size": "3.2B", "quantization_level": "Q4_K_M"},
                }
            )

    monkeypatch.setattr(ollama, "AsyncClient", _FakeClient)
    limits = await ModelCatalog("http://ollama.test", []).limits("llama3.2:3b")
    assert limits == ModelLimits(
        name="llama3.2:3b", context_length=131072, parameter_size="3.2B", quantization="Q4_K_M"
    )
