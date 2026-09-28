"""The server side of contracts/wire-types.json — the client side is
packages/client/test/wireContract.test.ts, which checks src/types.ts
against the same file. Together they keep the two descriptions of the wire
contract (api_schemas.py and types.ts) naming the same types and fields.

After changing a model in api_schemas.py (or one it uses), regenerate the
file and update types.ts to match:

    UPDATE_WIRE_CONTRACT=1 uv run pytest tests/test_wire_contract.py
"""

import json
import os
from enum import Enum
from pathlib import Path
from typing import Any

from pydantic import BaseModel
from pydantic.json_schema import models_json_schema

import llm_pipeline.api_schemas as api_schemas
from llm_pipeline.main import app

CONTRACT = Path(__file__).parents[2] / "contracts" / "wire-types.json"


def wire_contract() -> dict[str, dict[str, list[Any]]]:
    """Every model defined in api_schemas.py — and every model or enum they
    use — by name: an object's field names, an enum's values."""
    models = [
        value
        for value in vars(api_schemas).values()
        if isinstance(value, type)
        and issubclass(value, BaseModel)
        and value.__module__ == api_schemas.__name__
    ]
    _, schema = models_json_schema([(model, "validation") for model in models])
    objects: dict[str, list[Any]] = {}
    enums: dict[str, list[Any]] = {}
    for name, definition in schema["$defs"].items():
        if "enum" in definition:
            enums[name] = sorted(definition["enum"])
        else:
            objects[name] = sorted(definition.get("properties", {}))
    return {"objects": dict(sorted(objects.items())), "enums": dict(sorted(enums.items()))}


def test_the_wire_contract_file_is_current() -> None:
    current = wire_contract()
    if os.environ.get("UPDATE_WIRE_CONTRACT"):
        CONTRACT.write_text(json.dumps(current, indent=2) + "\n")
    assert json.loads(CONTRACT.read_text()) == current, (
        "api_schemas.py no longer matches contracts/wire-types.json — run "
        "UPDATE_WIRE_CONTRACT=1 uv run pytest tests/test_wire_contract.py, then "
        "update packages/client/src/types.ts to match"
    )


def test_every_wire_enum_is_an_enum_type() -> None:
    """A Literal would be inlined into each field and never reach the
    contract; the ones clients branch on are real enums."""
    assert issubclass(api_schemas.ErrorCode, Enum)
    assert "ErrorCode" in wire_contract()["enums"]


def test_openapi_describes_the_definitions_it_accepts_and_returns() -> None:
    """Definitions and presets travel as plain JSON the server validates
    itself, but the OpenAPI schema still says what they contain."""
    spec = app.openapi()
    schemas = spec["components"]["schemas"]
    for model, field in [
        ("PipelineDefinitionResponse", "definition"),
        ("SavePipelineRequest", "definition"),
        ("PresetResponse", "preset"),
    ]:
        documented_as = "NodePreset" if field == "preset" else "PipelineDefinition"
        ref = schemas[model]["properties"][field]["$ref"]
        assert ref == f"#/components/schemas/{documented_as}"
    assert {"PipelineDefinition", "NodeConfig", "NodePreset"} <= set(schemas)
