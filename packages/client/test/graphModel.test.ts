import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  appendNodeText,
  applyStreamEvent,
  applyStreamStopped,
  buildGraphModel,
  createGraphViewState,
  detailFromDefinition,
} from "../src/graphModel.js";
import type { AskStreamEvent, PipelineDefinition } from "../src/types.js";

const def: PipelineDefinition = {
  name: "p",
  nodes: [
    { id: "a", prompt_template: "{{ input }}", model: { provider: "ollama", name: "m" } },
    { id: "b", depends_on: ["a"], prompt_template: "", model: { provider: "ollama", name: "m" } },
    { id: "c", depends_on: ["a"], prompt_template: "", model: { provider: "ollama", name: "m" } },
  ],
  output_nodes: ["b", "c"],
};

const start = (id: string): AskStreamEvent => ({ type: "node_start", data: { node_id: id, model_name: "ollama:m" } });
const complete = (id: string): AskStreamEvent => ({
  type: "node_complete",
  data: { node: { node_id: id, model_name: "ollama:m", output: "", duration_ms: 1 } },
});

describe("detailFromDefinition", () => {
  it("labels a node that inherits the pipeline's default model", () => {
    const inherits: PipelineDefinition = {
      name: "d",
      defaults: { model: { provider: "ollama", name: "llama3" } },
      nodes: [
        { id: "draft", prompt_template: "{{ input }}" },
        { id: "polish", depends_on: ["draft"], prompt_template: "", model: { provider: "ollama", name: "gemma3" } },
      ],
      output_nodes: ["polish"],
    };
    assert.deepEqual(
      detailFromDefinition(inherits).nodes.map((n) => n.model),
      ["ollama:llama3 (default)", "ollama:gemma3"]
    );
  });

  it("feeds drafts through the same layout as stored pipelines", () => {
    const graph = buildGraphModel(detailFromDefinition(def));
    assert.deepEqual(graph.nodes.map((n) => [n.id, n.level, n.isOutputCandidate]), [
      ["a", 0, false],
      ["b", 1, true],
      ["c", 1, true],
    ]);
  });
});

describe("node_start events", () => {
  it("drive running status instead of inference", () => {
    const graph = buildGraphModel(detailFromDefinition(def));
    let state = createGraphViewState(graph);
    state = applyStreamEvent(state, start("a"));
    assert.equal(state.nodeStatus.a, "running");
    assert.equal(state.serverReportsStarts, true);

    state = applyStreamEvent(state, complete("a"));
    // b and c are eligible, but not running until the server says so.
    assert.deepEqual(state.nodeStatus, { a: "complete", b: "not-started", c: "not-started" });

    state = applyStreamEvent(state, start("c"));
    assert.deepEqual(state.nodeStatus, { a: "complete", b: "not-started", c: "running" });
  });

  it("clears inferred running on the first real start", () => {
    const graph = buildGraphModel(detailFromDefinition({ ...def, nodes: [def.nodes[0]!, { ...def.nodes[1]!, depends_on: [] }] , output_nodes: ["b"] }));
    let state = createGraphViewState(graph, { running: true });
    assert.deepEqual(state.nodeStatus, { a: "running", b: "running" });
    state = applyStreamEvent(state, start("a"));
    assert.deepEqual(state.nodeStatus, { a: "running", b: "not-started" });
  });

  it("a loop re-run marks a completed node running again", () => {
    const graph = buildGraphModel(detailFromDefinition(def));
    let state = createGraphViewState(graph);
    state = applyStreamEvent(applyStreamEvent(state, start("a")), complete("a"));
    state = applyStreamEvent(state, start("a"));
    assert.equal(state.nodeStatus.a, "running");
  });

  it("without node_start the old inference still works", () => {
    const graph = buildGraphModel(detailFromDefinition(def));
    let state = createGraphViewState(graph, { running: true });
    state = applyStreamEvent(state, complete("a"));
    assert.deepEqual(state.nodeStatus, { a: "complete", b: "running", c: "running" });
  });
});

describe("appendNodeText", () => {
  const token = (id: string, text: string): AskStreamEvent => ({ type: "node_token", data: { node_id: id, text } });

  it("accumulates tokens per node, resets on (re)start, and settles on the final output", () => {
    let texts: Record<string, string> = {};
    texts = appendNodeText(texts, start("a"));
    texts = appendNodeText(texts, token("a", "hel"));
    texts = appendNodeText(texts, token("b", "x"));
    texts = appendNodeText(texts, token("a", "lo"));
    assert.deepEqual(texts, { a: "hello", b: "x" });

    // A retry announces a fresh start: partial text from the failed attempt goes.
    texts = appendNodeText(texts, { type: "node_start", data: { node_id: "a", model_name: "m", attempt: 2 } });
    assert.equal(texts.a, "");

    texts = appendNodeText(texts, complete("a"));
    assert.equal(texts.a, "");
    const done = { ...texts };
    assert.equal(appendNodeText(done, { type: "loop_iteration", data: { loop_id: "l", iteration: 1 } }), done);
  });

  it("node_token never changes node status", () => {
    const graph = buildGraphModel(detailFromDefinition(def));
    const state = applyStreamEvent(createGraphViewState(graph), start("a"));
    assert.equal(applyStreamEvent(state, token("a", "x")), state);
  });
});

describe("applyStreamStopped", () => {
  it("returns running nodes to idle and keeps finished ones", () => {
    let state = createGraphViewState(buildGraphModel(detailFromDefinition(def)));
    const start = (id: string): AskStreamEvent => ({ type: "node_start", data: { node_id: id, model_name: "ollama:m" } });
    state = applyStreamEvent(state, start("a"));
    state = applyStreamEvent(state, { type: "node_complete", data: { node: { node_id: "a", model_name: "ollama:m", output: "x", duration_ms: 1 } } });
    state = applyStreamEvent(state, start("b"));
    const stopped = applyStreamStopped(state);
    assert.equal(stopped.nodeStatus.a, "complete");
    assert.equal(stopped.nodeStatus.b, "not-started");
    assert.equal(stopped.connectionError, null, "a stop is not an error");
  });
});

describe("edges", () => {
  const looped: PipelineDefinition = {
    name: "l",
    nodes: ["cls", "gen", "fix", "done"].map((id, i, ids) => ({
      id,
      depends_on: id === "fix" ? ["gen"] : id === "done" ? ["fix"] : [],
      prompt_template: i === 0 ? "{{ input }}" : `{{ ${ids[Math.max(0, i - 1)]}.output }}`,
      model: { provider: "ollama" as const, name: "m" },
    })),
    branches: [{ id: "br", from: "cls", routes: [{ when: "'G' in output", to: "gen" }, { default: true, to: "done" }] }],
    loops: [{ id: "lp", from: "fix", back_to: "gen", exit_to: "done", exit_when: "'OK' in output", max_iterations: 3 }],
    output_nodes: ["done"],
  };

  it("carry only what their kind needs", () => {
    const { edges } = buildGraphModel(detailFromDefinition(looped));
    const shapes = edges.map((e) => [e.kind, Object.keys(e).sort().join(",")]);
    assert.deepEqual(shapes, [
      ["plain", "from,kind,to"],
      ["branch", "branchId,from,isDefaultRoute,kind,label,routeIndex,to"],
      ["branch", "branchId,from,isDefaultRoute,kind,label,routeIndex,to"],
      ["loop-continue", "from,kind,label,loopId,maxIterations,to"],
      ["loop-exit", "from,kind,label,loopId,maxIterations,to"],
    ]);
  });

  it("need no null checks once their kind is known", () => {
    const { edges } = buildGraphModel(detailFromDefinition(looped));
    for (const edge of edges) {
      if (edge.kind === "branch") {
        const route: [string, number] = [edge.branchId, edge.routeIndex];
        assert.equal(route[0], "br");
      } else if (edge.kind === "loop-continue" || edge.kind === "loop-exit") {
        const loop: [string, number] = [edge.loopId, edge.maxIterations];
        assert.deepEqual(loop, ["lp", 3]);
      } else {
        // @ts-expect-error — a plain edge belongs to no branch
        void edge.branchId;
      }
    }
  });
});

describe("multi-target branch routes", () => {
  const routed: PipelineDefinition = {
    name: "r",
    nodes: ["cls", "tech", "sec", "gen"].map((id) => ({
      id,
      prompt_template: "{{ input }}",
      model: { provider: "ollama" as const, name: "m" },
    })),
    branches: [{ id: "br", from: "cls", routes: [{ when: "'T' in output", to: ["tech", "sec"] }, { default: true, to: "gen" }] }],
    output_nodes: ["tech", "gen"],
  };

  it("draws one edge per target, grouped by route", () => {
    const graph = buildGraphModel(detailFromDefinition(routed));
    const branchEdges = graph.edges.filter((e) => e.kind === "branch");
    assert.deepEqual(branchEdges.map((e) => [e.to, e.routeIndex]), [["tech", 0], ["sec", 0], ["gen", 1]]);
    assert.deepEqual(graph.nodes.map((n) => [n.id, n.level]), [["cls", 0], ["tech", 1], ["sec", 1], ["gen", 1]]);
  });

  it("a completed target marks its whole route taken and only the other route's targets dead", () => {
    const graph = buildGraphModel(detailFromDefinition(routed));
    let state = createGraphViewState(graph, { running: true });
    state = applyStreamEvent(state, complete("cls"));
    state = applyStreamEvent(state, complete("tech"));
    assert.deepEqual(state.branchOutcomes["br"], { branchId: "br", takenTargets: ["tech", "sec"] });
    assert.equal(state.nodeStatus["sec"], "running", "the sibling target of the same route still runs");
    assert.equal(state.nodeStatus["gen"], "not-started");
  });
});
