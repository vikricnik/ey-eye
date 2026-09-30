import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { PipelineDefinition } from "@llm-pipeline/client";

import {
  chatSummary,
  paletteSummary,
  pipelineSectionSummary,
  pipelineState,
  selectionHeading,
  selectionSummary,
  testsSummary,
} from "../src/ui/sectionSummaries";
import type { Turn } from "../src/run/Chat";
import type { TestRunState } from "../src/tests/TestsView";

const definition = {
  name: "p",
  nodes: [
    { id: "a", model: { provider: "ollama", name: "llama3", temperature: 0.3 } },
    { id: "b" },
  ],
  defaults: { model: { provider: "ollama", name: "qwen", temperature: 0.7 } },
  output_nodes: ["b"],
} as unknown as PipelineDefinition;

const turn = (status: Turn["status"], elapsedMs?: number) =>
  ({ id: 1, pipeline: "p", prompt: "hi", history: [], status, nodeOutputs: [], log: [], elapsedMs }) as unknown as Turn;

describe("selectionHeading", () => {
  it("names the selected node or dependency", () => {
    assert.deepEqual(selectionHeading(definition, { kind: "node", id: "a" }), { title: "Node", detail: "a" });
    assert.deepEqual(selectionHeading(definition, { kind: "edge", from: "a", to: "b" }), { title: "Dependency", detail: "a → b" });
  });

  it("is just Node with nothing selected, or a node that's gone", () => {
    assert.deepEqual(selectionHeading(definition, null), { title: "Node" });
    assert.deepEqual(selectionHeading(definition, { kind: "node", id: "gone" }), { title: "Node" });
  });
});

describe("selectionSummary", () => {
  it("gives a node's model and temperature — its own, or the pipeline default's", () => {
    assert.equal(selectionSummary(definition, { kind: "node", id: "a" }), "ollama:llama3 · T 0.3");
    assert.equal(selectionSummary(definition, { kind: "node", id: "b" }), "pipeline default · T 0.7");
  });

  it("says what a dependency means, or that nothing is selected", () => {
    assert.equal(selectionSummary(definition, { kind: "edge", from: "a", to: "b" }), "b waits for a");
    assert.equal(selectionSummary(definition, null), "nothing selected");
  });
});

describe("chatSummary", () => {
  it("counts the runs, with how long the last one took", () => {
    assert.equal(chatSummary([], false), "no messages yet");
    assert.equal(chatSummary([turn("done", 752)], false), "1 run · last 752ms");
    assert.equal(chatSummary([turn("done", 1000), turn("done", 2400), turn("error")], false), "3 runs");
  });

  it("says so while a run is going", () => {
    assert.equal(chatSummary([turn("running")], true), "running…");
  });
});

describe("pipelineSectionSummary", () => {
  it("names the answering node and the history setting", () => {
    assert.equal(pipelineSectionSummary(definition), "answer from b · history 6 turns");
    assert.equal(
      pipelineSectionSummary({ ...definition, history: { max_turns: 0 } } as PipelineDefinition),
      "answer from b · history off"
    );
    assert.equal(
      pipelineSectionSummary({ ...definition, history: { max_turns: 1 } } as PipelineDefinition),
      "answer from b · history 1 turn"
    );
  });
});

describe("testsSummary", () => {
  const result = (testCase: string, passed: boolean | null) => ({
    case: testCase, variant: "current", passed, expectations: [], duration_ms: 1, prompt_tokens: 0, completion_tokens: 0,
  });
  const run = (status: TestRunState["status"], results: ReturnType<typeof result>[]): TestRunState => ({
    status,
    cases: ["a", "b", "c", "d"],
    variants: ["current"],
    results: Object.fromEntries(results.map((r) => [`${r.case}\u0000current`, r])),
  });

  it("counts the cases before any run", () => {
    assert.equal(testsSummary(0, null), "no test cases");
    assert.equal(testsSummary(4, null), "4 cases");
  });

  it("shows progress during a run", () => {
    assert.equal(testsSummary(4, run("running", [result("a", true), result("b", false)])), "running 2/4");
  });

  it("gives the pass count after a run, ignoring cases with nothing to check", () => {
    assert.equal(testsSummary(4, run("done", [result("a", true), result("b", false), result("c", true), result("d", null)])), "4 cases · 2/3 passed");
  });

  it("says when the run was stopped or failed", () => {
    assert.equal(testsSummary(4, run("stopped", [result("a", true)])), "4 cases · stopped");
    assert.equal(testsSummary(4, { ...run("error", []), error: "boom" }), "4 cases · test run failed");
  });
});

describe("paletteSummary", () => {
  it("counts the presets beside the blank node", () => {
    assert.equal(paletteSummary(0), "LLM node · no presets");
    assert.equal(paletteSummary(1), "LLM node · 1 preset");
    assert.equal(paletteSummary(2), "LLM node · 2 presets");
  });
});

describe("pipelineState", () => {
  it("is ok when saved", () => {
    assert.deepEqual(pipelineState({ dirty: false }, { status: "idle" }), { tone: "ok", label: "saved" });
  });

  it("is a warning while there are unsaved changes", () => {
    assert.deepEqual(pipelineState({ dirty: true }, { status: "valid", modelIssues: [], warnings: [] }), { tone: "warn", label: "valid · unsaved" });
    assert.deepEqual(
      pipelineState({ dirty: true }, { status: "valid", modelIssues: [{ nodeId: "a", message: "x" }], warnings: [{ nodeId: null, message: "y" }] }),
      { tone: "warn", label: "valid · 2 warnings" }
    );
    assert.deepEqual(pipelineState({ dirty: true }, { status: "checking" }), { tone: "warn", label: "checking…" });
    assert.deepEqual(pipelineState({ dirty: true }, { status: "unavailable", message: "down" }), { tone: "warn", label: "can't validate" });
    assert.deepEqual(pipelineState({ dirty: true }, { status: "idle" }), { tone: "warn", label: "unsaved" });
  });

  it("is an error when invalid", () => {
    assert.deepEqual(pipelineState({ dirty: true }, { status: "invalid", message: "m", nodeId: "a" }), { tone: "error", label: "invalid · a" });
    assert.deepEqual(pipelineState({ dirty: true }, { status: "invalid", message: "m", nodeId: null }), { tone: "error", label: "invalid" });
  });

  it("says so before a pipeline has loaded", () => {
    assert.deepEqual(pipelineState(null, { status: "idle" }), { tone: "warn", label: "no pipeline loaded" });
  });
});
