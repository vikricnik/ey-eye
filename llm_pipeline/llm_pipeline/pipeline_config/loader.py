import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from llm_pipeline.pipeline_config.schema import PipelineDefinition

_SAFE_NAME = re.compile(r"[a-zA-Z0-9_-]+")


def is_safe_name(name: str) -> bool:
    """Whether a client-supplied pipeline or preset name can be used as a
    file stem: only letters, digits, '-' and '_' — which closes off
    path traversal ("../../etc/passwd") and names like "demo\\n" before
    they reach disk. PipelineCache applies it to reads, pipeline_store.py to
    writes."""
    return _SAFE_NAME.fullmatch(name) is not None


def load_pipeline_definition(path: Path) -> PipelineDefinition:
    """Loads and fully validates a pipeline YAML file. Raises pydantic's
    ValidationError (wrapping any check in validation.py) on anything invalid."""
    with open(path) as f:
        raw = yaml.safe_load(f)
    return PipelineDefinition.model_validate(raw)


@dataclass(frozen=True)
class PipelineListing:
    """A loadable pipeline on disk, as listings show it."""

    name: str
    description: str
    filename: str


def list_available_pipelines(directory: Path) -> list[PipelineListing]:
    """Every loadable pipeline in a directory — used by GET /v1/pipelines.
    Files that fail to load are skipped rather than crashing the whole
    listing; run validation in CI to catch those before deploy."""
    results: list[PipelineListing] = []
    for yaml_path in sorted(directory.glob("*.yaml")):
        try:
            definition = load_pipeline_definition(yaml_path)
        except Exception:
            continue
        results.append(
            PipelineListing(
                name=definition.name,
                description=definition.description,
                filename=yaml_path.name,
            )
        )
    return results
