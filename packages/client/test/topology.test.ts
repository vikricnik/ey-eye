import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { detailFromDefinition } from "../src/graphModel.js";
import { branchTargets, conditionalSources, effectiveRoots } from "../src/topology.js";
import type { PipelineDefinition } from "../src/types.js";

interface TopologyCase {
  name: string;
  definition: PipelineDefinition;
  expected: { effective_roots: string[]; conditional_sources: string[]; branch_targets: string[] };
}

const { cases } = JSON.parse(
  readFileSync(new URL("../../../contracts/topology-cases.json", import.meta.url), "utf8")
) as { cases: TopologyCase[] };

describe("topology contract (same cases as llm_pipeline/tests/test_topology_contract.py)", () => {
  for (const c of cases) {
    it(c.name, () => {
      const detail = detailFromDefinition(c.definition);
      assert.deepEqual([...effectiveRoots(detail)].sort(), c.expected.effective_roots);
      assert.deepEqual([...conditionalSources(detail)].sort(), c.expected.conditional_sources);
      assert.deepEqual([...branchTargets(detail)].sort(), c.expected.branch_targets);
    });
  }
});
