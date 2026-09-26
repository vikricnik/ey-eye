"""
Pipeline YAML definitions — schema.py for the Pydantic models, validation.py
for the DAG-level cross-field checks, loader.py for reading/listing files
from disk.

Re-exports the public surface so existing call sites can keep writing
`from llm_pipeline.pipeline_config import PipelineDefinition, ...` without
needing to know which submodule anything lives in.
"""

from llm_pipeline.pipeline_config.loader import list_available_pipelines, load_pipeline_definition
from llm_pipeline.pipeline_config.presets import NodePreset
from llm_pipeline.pipeline_config.schema import (
    BranchConfig,
    BranchRoute,
    EvalCase,
    EvalExpectation,
    EvalJudge,
    ExecutionConfig,
    LoopConfig,
    NodeConfig,
    NodeLayout,
    NodeModelConfig,
    PipelineDefinition,
    TestsConfig,
)
from llm_pipeline.pipeline_config.validation import (
    END_SENTINEL,
    PipelineValidationError,
    validate_pipeline_dag,
)

__all__ = [
    "END_SENTINEL",
    "BranchConfig",
    "BranchRoute",
    "EvalCase",
    "EvalExpectation",
    "EvalJudge",
    "ExecutionConfig",
    "LoopConfig",
    "NodeConfig",
    "NodeLayout",
    "NodeModelConfig",
    "NodePreset",
    "PipelineDefinition",
    "PipelineValidationError",
    "TestsConfig",
    "list_available_pipelines",
    "load_pipeline_definition",
    "validate_pipeline_dag",
]
