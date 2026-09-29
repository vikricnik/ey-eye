import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { PipelineDefinition } from "@llm-pipeline/client";
import {
  LEVEL_SPACING,
  SIBLING_SPACING,
  autoLayout,
  definitionToFlow,
  dependencyEdgeId,
  graphOf,
  parseDependencyEdgeId,
} from "../src/editor/conversion";

const model = { provider: "ollama" as const, name: "m" };
const diamond: PipelineDefinition = {
  name: "d",
  nodes: [
    { id: "a", model, prompt_template: "{{ input }}" },
    { id: "b", depends_on: ["a"], model, prompt_template: "{{ a.output }}" },
    { id: "c", depends_on: ["a"], model, prompt_template: "{{ a.output }}" },
    { id: "d", depends_on: ["b", "c"], model, prompt_template: "{{ b.output }} {{ c.output }}" },
  ],
  loops: [{ id: "again", from: "d", back_to: "b", exit_to: "END", exit_when: 'output.startswith("OK")', max_iterations: 2 }],
  output_nodes: ["d"],
};

describe("autoLayout", () => {
  it("lays levels out top to bottom, each row centred", () => {
    const layout = autoLayout(graphOf(diamond));
    assert.deepEqual(layout.a, { x: 0, y: 0 });
    assert.deepEqual(layout.b, { x: -SIBLING_SPACING / 2, y: LEVEL_SPACING });
    assert.deepEqual(layout.c, { x: SIBLING_SPACING / 2, y: LEVEL_SPACING });
    assert.deepEqual(layout.d, { x: 0, y: 2 * LEVEL_SPACING });
  });
});

describe("definitionToFlow", () => {
  const flow = definitionToFlow({
    definition: { ...diamond, nodes: diamond.nodes.map((n) => (n.id === "c" ? { ...n, layout: { x: 500, y: 9 } } : n)) },
    graph: graphOf(diamond),
    status: { a: "complete", b: "running" },
    outputs: {
      a: {
        node_id: "a",
        model_name: "ollama:m",
        output: "x",
        duration_ms: 5,
        replayed: true,
        usage: { prompt_tokens: 10, completion_tokens: 2, generation_ms: 1, context_window: 4096 },
      },
    },
    liveText: { b: "partial answer" },
    validation: { status: "invalid", message: "bad", nodeId: "c" },
    editable: true,
  });
  const node = (id: string) => flow.nodes.find((n) => n.id === id)!;

  it("gives each card what it shows", () => {
    assert.equal(node("a").data.replayed, true);
    assert.equal(node("a").data.usage?.context_window, 4096);
    assert.equal(node("b").data.liveText, "partial answer", "only while running");
    assert.equal(node("a").data.liveText, undefined);
    assert.equal(node("c").data.problem, "error");
    assert.equal(node("d").data.isOutput, true);
    assert.deepEqual(node("c").position, { x: 500, y: 9 }, "a saved position wins");
  });

  it("draws dependencies and loops as distinct edges", () => {
    const deps = flow.edges.filter((e) => e.className === "edge-plain").map((e) => e.id);
    assert.deepEqual(deps.sort(), ["dep:a->b", "dep:a->c", "dep:b->d", "dep:c->d"]);
    assert.deepEqual(parseDependencyEdgeId("dep:a->b"), { from: "a", to: "b" });
    assert.equal(dependencyEdgeId("a", "b"), "dep:a->b");
    assert.deepEqual(parseDependencyEdgeId(dependencyEdgeId("x_1", "y-2")), { from: "x_1", to: "y-2" });
    assert.equal(parseDependencyEdgeId("loop:again:back"), null);
    const loop = flow.edges.find((e) => e.className === "edge-loop")!;
    assert.equal(loop.id, "loop:again:back");
    assert.match(String(loop.label), /again ≤2/);
  });
});

describe("branch routes with several targets", () => {
  const routed: PipelineDefinition = {
    name: "r",
    nodes: ["cls", "tech", "sec", "gen"].map((id) => ({ id, model, prompt_template: "{{ input }}" })),
    branches: [
      {
        id: "br",
        from: "cls",
        routes: [
          { when: "'T' in output", to: ["tech", "sec"] },
          { when: "'S' in output", to: "sec" },
          { default: true, to: "gen" },
        ],
      },
    ],
    output_nodes: ["tech", "gen"],
  };

  it("draws one edge per target, with ids unique even when two routes share a target", () => {
    const flow = definitionToFlow({
      definition: routed,
      graph: graphOf(routed),
      status: {},
      outputs: {},
      liveText: {},
      validation: { status: "valid", modelIssues: [], warnings: [] },
      editable: true,
    });
    const branchEdges = flow.edges.filter((e) => e.className === "edge-branch");
    assert.deepEqual(
      branchEdges.map((e) => [e.id, e.target]),
      [
        ["branch:br:0:tech", "tech"],
        ["branch:br:0:sec", "sec"],
        ["branch:br:1:sec", "sec"],
        ["branch:br:2:gen", "gen"],
      ]
    );
  });
});
