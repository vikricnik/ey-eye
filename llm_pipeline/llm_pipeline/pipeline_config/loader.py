from pathlib import Path
import yaml

from llm_pipeline.pipeline_config.schema import PipelineDefinition
from llm_pipeline.api_schemas import PipelineSummary


def load_pipeline_definition(path: Path) -> PipelineDefinition:
    """Loads and fully validates a pipeline YAML file. Raises pydantic's
    ValidationError (wrapping any check in validation.py) on anything invalid."""
    with open(path) as f:
        raw = yaml.safe_load(f)
    return PipelineDefinition.model_validate(raw)


def list_available_pipelines(directory: Path) -> list[PipelineSummary]:
    """Every loadable pipeline in a directory — used by GET /pipelines.
    Files that fail to load are skipped rather than crashing the whole
    listing; run validation in CI to catch those before deploy."""
    results: list[PipelineSummary] = []
    for yaml_path in sorted(directory.glob("*.yaml")):
        try:
            definition = load_pipeline_definition(yaml_path)
        except Exception:
            continue
        results.append(
            PipelineSummary(
                name=definition.name,
                description=definition.description,
                filename=yaml_path.name,
            )
        )
    return results
