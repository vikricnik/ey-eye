class PipelineExecutionError(Exception):
    """Raised when a pipeline run can't produce a usable result — e.g. the
    output_node's dependencies all failed. Distinct from ProviderError (one
    model call failing), this represents the run as a whole having nothing
    left to return.

    node_id/loop_id optionally identify WHICH node or loop the failure is
    attributable to, when that's known at the raise site — routers/ask.py
    surfaces whichever is set in the streamed error event's `details` so a
    live-status client (the visual DAG graph) can mark that specific node
    as failed instead of only knowing the run as a whole failed."""

    def __init__(
        self, message: str, *, node_id: str | None = None, loop_id: str | None = None
    ) -> None:
        super().__init__(message)
        self.node_id = node_id
        self.loop_id = loop_id


class PipelineNotFoundError(Exception):
    """Raised when a client requests a pipeline_name with no matching
    <pipelines_dir>/<name>.yaml file."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f"No pipeline named '{name}'")


class PipelineDefinitionError(Exception):
    """Raised when a pipeline YAML file fails schema/DAG validation."""
