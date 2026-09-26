import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { appendRunLog, endRunLog, liveTextOf } from "../src/runLog.js";
import type { RunLogEntry } from "../src/runLog.js";
import type { AskStreamEvent } from "../src/types.js";

const start = (id: string, extra: { attempt?: number; prompt?: string; system?: string | null } = {}): AskStreamEvent => ({
  type: "node_start",
  data: { node_id: id, model_name: "ollama:m", prompt: extra.prompt ?? `prompt for ${id}`, system: extra.system ?? null, ...(extra.attempt ? { attempt: extra.attempt } : {}) },
});
const token = (id: string, text: string): AskStreamEvent => ({ type: "node_token", data: { node_id: id, text } });
const complete = (id: string, output: string): AskStreamEvent => ({
  type: "node_complete",
  data: { node: { node_id: id, model_name: "ollama:m", output, duration_ms: 12 } },
});

function fold(events: AskStreamEvent[]): RunLogEntry[] {
  return events.reduce(appendRunLog, [] as RunLogEntry[]);
}

describe("appendRunLog", () => {
  it("keeps the usage a node reported when it completes", () => {
    const usage = { prompt_tokens: 3900, completion_tokens: 12, generation_ms: 300, context_window: 4096 };
    const log = fold([
      start("a"),
      { type: "node_complete", data: { node: { node_id: "a", model_name: "ollama:m", output: "x", duration_ms: 5, usage } } },
      start("b"),
    ]);
    assert.deepEqual(log[0]!.usage, usage);
    assert.equal(log[1]!.usage, null, "nothing until it completes");
  });

  it("records what each node received and replied, in start order, with parallel nodes interleaved", () => {
    const log = fold([
      start("a", { system: "Be terse." }),
      start("b"),
      token("a", "hel"),
      token("b", "x"),
      token("a", "lo"),
      complete("a", "hello"),
      complete("b", "xy"),
    ]);
    assert.deepEqual(
      log.map((e) => [e.key, e.prompt, e.system, e.output, e.status, e.durationMs]),
      [
        ["a#1", "prompt for a", "Be terse.", "hello", "complete", 12],
        ["b#1", "prompt for b", null, "xy", "complete", 12],
      ]
    );
  });

  it("gives each loop iteration its own entry", () => {
    const log = fold([
      start("gen", { prompt: "draft" }),
      complete("gen", "v1"),
      start("gen", { prompt: "revise v1" }),
      token("gen", "v"),
      complete("gen", "v2"),
    ]);
    assert.deepEqual(
      log.map((e) => [e.key, e.iteration, e.prompt, e.output]),
      [
        ["gen#1", 1, "draft", "v1"],
        ["gen#2", 2, "revise v1", "v2"],
      ]
    );
  });

  it("a retry resets the current entry instead of adding one", () => {
    const log = fold([start("a"), token("a", "partial"), start("a", { attempt: 2 }), token("a", "ok")]);
    assert.equal(log.length, 1);
    assert.equal(log[0]!.attempt, 2);
    assert.equal(log[0]!.output, "ok");
    assert.deepEqual(liveTextOf(log), { a: "ok" });
  });

  it("ignores stray tokens and records replies even without a start event", () => {
    assert.deepEqual(fold([token("ghost", "x")]), []);
    const log = fold([complete("a", "done")]);
    assert.equal(log[0]!.status, "complete");
    assert.equal(log[0]!.prompt, null);
  });
});

describe("endRunLog", () => {
  it("marks the failed node failed and anything else still running stopped", () => {
    const log = endRunLog(fold([start("a"), start("b"), complete("c", "x")]), "a");
    assert.deepEqual(log.map((e) => [e.nodeId, e.status]), [
      ["a", "failed"],
      ["b", "stopped"],
      ["c", "complete"],
    ]);
    assert.deepEqual(liveTextOf(log), {});
  });
});
