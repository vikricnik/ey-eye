"""The server side of contracts/topology-cases.json — the client side is
packages/client/test/topology.test.ts. Same cases, same expectations."""

import json
from pathlib import Path
from typing import Any

import pytest

from llm_pipeline.pipeline_config import PipelineDefinition, Topology

CASES = json.loads((Path(__file__).parents[2] / "contracts" / "topology-cases.json").read_text())[
    "cases"
]


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_server_topology_matches_the_shared_contract(case: dict[str, Any]) -> None:
    definition = PipelineDefinition.model_validate(case["definition"])
    expected = case["expected"]
    topology = Topology(definition)
    assert sorted(topology.effective_roots) == expected["effective_roots"]
    assert sorted(topology.conditional_sources) == expected["conditional_sources"]
    assert sorted(topology.branch_targets) == expected["branch_targets"]
