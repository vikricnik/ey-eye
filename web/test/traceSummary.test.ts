import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { RunLogEntry } from "@llm-pipeline/client";

import { nodeTraceSummary } from "../src/editor/traceSummary";

const entry = (nodeId: string, status: RunLogEntry["status"], durationMs: number | null = null) => ({
  nodeId,
  status,
  durationMs,
});

describe("nodeTraceSummary", () => {
  it("says so when the node hasn't run in this session", () => {
    assert.equal(nodeTraceSummary("b", []), "hasn't run yet");
    assert.equal(nodeTraceSummary("b", [{ log: [entry("a", "complete", 900)] }]), "hasn't run yet");
  });

  it("describes the latest run the node took part in, numbered among all runs", () => {
    const turns = [
      { log: [entry("a", "complete", 400), entry("b", "complete", 1800)] },
      { log: [entry("a", "complete", 300)] },
    ];
    assert.equal(nodeTraceSummary("b", turns), "run 1 · 1.8s");
    assert.equal(nodeTraceSummary("a", turns), "run 2 · 300ms");
  });

  it("uses the node's last execution in a run — a loop's final pass", () => {
    const turns = [{ log: [entry("b", "complete", 500), entry("b", "complete", 2500)] }];
    assert.equal(nodeTraceSummary("b", turns), "run 1 · 2.5s");
  });

  it("marks a node that's running, failed or was stopped", () => {
    assert.equal(nodeTraceSummary("b", [{ log: [entry("b", "running")] }]), "run 1 · live");
    assert.equal(nodeTraceSummary("b", [{ log: [entry("b", "failed", 200)] }]), "run 1 · failed");
    assert.equal(nodeTraceSummary("b", [{ log: [entry("b", "stopped")] }]), "run 1 · stopped");
  });

  it("leaves out a duration the server didn't report", () => {
    assert.equal(nodeTraceSummary("b", [{ log: [entry("b", "complete", null)] }]), "run 1");
  });
});
