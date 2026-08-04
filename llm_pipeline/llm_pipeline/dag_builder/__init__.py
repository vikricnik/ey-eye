"""
Turns a validated PipelineDefinition into a compiled, runnable LangGraph.
See graph.py for the assembly logic and its module docstring for the full
mechanics; node_types.py for the node-type registry (the extension point
for future retrieval/tool/human_approval node types); branches.py/loops.py
for the two conditional-control-flow mechanisms; templating.py for prompt
rendering.
"""

from llm_pipeline.dag_builder.graph import build_graph
from llm_pipeline.dag_builder.node_types import (
    NodeCallable,
    RouterCallable,
    NODE_BUILDERS,
    build_node,
    build_llm_call_node,
)

__all__ = [
    "build_graph",
    "NodeCallable",
    "RouterCallable",
    "NODE_BUILDERS",
    "build_node",
    "build_llm_call_node",
]
