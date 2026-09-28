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


class DefinitionInvalidError(Exception):
    """A client-submitted pipeline or preset failed validation. `node_id`
    names the node an editor should highlight, when the failure is
    attributable to one; `issues` lists every (location, message) pydantic
    reported, for clients that want the full picture."""

    def __init__(
        self,
        message: str,
        node_id: str | None = None,
        issues: list[tuple[str, str, str]] | None = None,
    ) -> None:
        super().__init__(message)
        self.node_id = node_id
        self.issues = issues or []


class RevisionConflictError(Exception):
    """A save was based on a different version of the file than the one now
    on disk — someone else saved in between, or the file was created or
    deleted since the client loaded it."""


class PipelineExistsError(RevisionConflictError):
    """A create (no base revision) for a name that is already taken."""


class ProtectedPipelineError(Exception):
    """A pipeline that can't be deleted — the server's default pipeline."""


class InvalidNameError(Exception):
    """A pipeline or preset name can't be used as a filename safely."""
