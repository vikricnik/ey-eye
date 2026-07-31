from langgraph.graph import StateGraph, END
from langgraph.graph.state import CompiledStateGraph

from llm_pipeline.models import PipelineState
from llm_pipeline.nodes import route_node, generate_and_validate_node, judge_node


def build_pipeline() -> CompiledStateGraph:
    """route -> generate_and_validate -> judge -> END

    Note: this graph shape is now static regardless of EXECUTION_MODE or how many
    generator models are configured per category — that variability is resolved
    at runtime inside generate_and_validate_node, since the generator set depends
    on the category, which is only known after routing (a fixed graph can't
    represent a variable-width fan-out).
    """
    graph: StateGraph = StateGraph(PipelineState)

    graph.add_node("route", route_node)
    graph.add_node("generate_and_validate", generate_and_validate_node)
    graph.add_node("judge", judge_node)

    graph.set_entry_point("route")
    graph.add_edge("route", "generate_and_validate")
    graph.add_edge("generate_and_validate", "judge")
    graph.add_edge("judge", END)

    return graph.compile()


pipeline: CompiledStateGraph = build_pipeline()
