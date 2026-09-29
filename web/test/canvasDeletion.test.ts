import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { PipelineDefinition } from "@llm-pipeline/client";
import { applyCanvasDeletion, deletionSummary } from "../src/editor/canvasDeletion";

const model = { provider: "ollama" as const, name: "m" };
const chain: PipelineDefinition = {
  name: "c",
  nodes: [
    { id: "a", model, prompt_template: "{{ message }}" },
    { id: "b", depends_on: ["a"], model, prompt_template: "{{ a.output }}" },
    { id: "c", depends_on: ["b"], model, prompt_template: "{{ b.output }}" },
  ],
  output_nodes: ["c"],
};

describe("applyCanvasDeletion", () => {
  it("removes a node and the edges React Flow deletes with it, in one go", () => {
    const next = applyCanvasDeletion(chain, {
      nodeIds: ["b"],
      dependencies: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    });
    assert.deepEqual(
      next.nodes.map((n) => n.id),
      ["a", "c"]
    );
    assert.deepEqual(next.nodes.find((n) => n.id === "c")?.depends_on ?? [], []);
  });

  it("removes a dependency on its own", () => {
    const next = applyCanvasDeletion(chain, { nodeIds: [], dependencies: [{ from: "a", to: "b" }] });
    assert.deepEqual(next.nodes.find((n) => n.id === "b")?.depends_on ?? [], []);
    assert.equal(next.nodes.length, 3);
  });
});

describe("deletionSummary", () => {
  it("names what was deleted — a node's edges go without saying", () => {
    assert.equal(deletionSummary({ nodeIds: ["b"], dependencies: [{ from: "a", to: "b" }] }), 'Deleted node "b"');
    assert.equal(deletionSummary({ nodeIds: ["a", "b"], dependencies: [] }), "Deleted 2 nodes");
    assert.equal(deletionSummary({ nodeIds: [], dependencies: [{ from: "a", to: "b" }] }), "Removed the dependency a → b");
    assert.equal(
      deletionSummary({ nodeIds: [], dependencies: [{ from: "a", to: "b" }, { from: "b", to: "c" }] }),
      "Removed 2 dependencies"
    );
  });
});
