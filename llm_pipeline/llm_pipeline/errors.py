class PipelineExecutionError(Exception):
    """Raised when a pipeline run can't produce a usable result — e.g. the
    output_node's dependencies all failed. Distinct from ProviderError (one
    model call failing), this represents the run as a whole having nothing
    left to return."""


class PipelineNotFoundError(Exception):
    """Raised when a client requests a pipeline_name with no matching
    <pipelines_dir>/<name>.yaml file."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"No pipeline named '{name}'")


class PipelineDefinitionError(Exception):
    """Raised when a pipeline YAML file fails schema/DAG validation."""
