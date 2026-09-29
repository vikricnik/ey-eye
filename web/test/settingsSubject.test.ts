import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { PipelineDefinition } from "@llm-pipeline/client";

import { settingsSubject } from "../src/editor/SettingsColumn";

const definition = {
  name: "p",
  nodes: [{ id: "a" }, { id: "b" }],
  output_nodes: ["b"],
} as unknown as PipelineDefinition;

describe("settingsSubject", () => {
  it("names what's selected", () => {
    assert.equal(settingsSubject(definition, { kind: "node", id: "a" }), "node");
    assert.equal(settingsSubject(definition, { kind: "edge", from: "a", to: "b" }), "dependency");
  });

  it("is the pipeline with nothing selected", () => {
    assert.equal(settingsSubject(definition, null), "pipeline");
    assert.equal(settingsSubject(definition, { kind: "pipeline" }), "pipeline");
  });

  it("falls back to the pipeline when the selected node is gone — deleted, renamed or undone", () => {
    assert.equal(settingsSubject(definition, { kind: "node", id: "gone" }), "pipeline");
  });
});
