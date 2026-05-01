"""LangGraph: synthesis → planner → stages → merge → validate ↔ repair."""

from __future__ import annotations

from typing import Any, Dict

from langgraph.graph import END, StateGraph

from services.case_generation.generation_nodes import (
    node_merge,
    node_planner,
    node_repair,
    node_stage_factory,
    node_synthesis,
    node_validate,
    route_after_validate,
)
from services.case_generation.template_slice import template_stage_ids


def build_case_generation_graph(template: Dict[str, Any]) -> Any:
    """Собрать граф с узлами stage по фактическим id из шаблона."""
    sids = template_stage_ids(template)
    workflow: StateGraph = StateGraph(dict)

    workflow.add_node("synthesis", node_synthesis)
    workflow.add_node("planner", node_planner)
    for sid in sids:
        safe = sid.replace("-", "_")
        workflow.add_node(f"stage_{safe}", node_stage_factory(sid))
    workflow.add_node("merge", node_merge)
    workflow.add_node("validate", node_validate)
    workflow.add_node("repair", node_repair)

    workflow.set_entry_point("synthesis")
    workflow.add_edge("synthesis", "planner")

    if not sids:
        workflow.add_edge("planner", "merge")
    else:
        workflow.add_edge("planner", f"stage_{sids[0].replace('-', '_')}")
        for i in range(len(sids) - 1):
            a = f"stage_{sids[i].replace('-', '_')}"
            b = f"stage_{sids[i + 1].replace('-', '_')}"
            workflow.add_edge(a, b)
        last = f"stage_{sids[-1].replace('-', '_')}"
        workflow.add_edge(last, "merge")

    workflow.add_edge("merge", "validate")
    workflow.add_conditional_edges(
        "validate",
        route_after_validate,
        {"end": END, "repair": "repair"},
    )
    workflow.add_edge("repair", "validate")

    return workflow.compile()


def run_generation_graph(initial: Dict[str, Any]) -> Dict[str, Any]:
    template = initial.get("structural_template") or {}
    app = build_case_generation_graph(template)
    return app.invoke(initial)
