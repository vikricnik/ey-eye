import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { ModelsResponse, PipelineDefinition } from "@llm-pipeline/client";
import { outageMessage, providersUsed, runBlockedReason, runOutage } from "../src/providerStatus";

const ollama = { provider: "ollama" as const, name: "llama3" };
const openai = { provider: "openai" as const, name: "gpt-4o" };

const local: PipelineDefinition = {
  name: "local",
  defaults: { model: ollama },
  nodes: [
    { id: "a", prompt_template: "{{ message }}" }, // the pipeline default
    { id: "b", depends_on: ["a"], model: ollama, prompt_template: "{{ a.output }}" },
  ],
  output_nodes: ["b"],
};
const mixed: PipelineDefinition = {
  ...local,
  nodes: [...local.nodes, { id: "c", depends_on: ["a"], model: openai, prompt_template: "{{ a.output }}" }],
};

const ERROR = "Ollama server unreachable at http://localhost:11434";
const models = (ollamaReachable: boolean): ModelsResponse => ({
  providers: [
    { provider: "ollama", reachable: ollamaReachable, ...(ollamaReachable ? {} : { error: ERROR }), models: [] },
    { provider: "openai", reachable: true, models: [{ name: "gpt-4o" }] },
  ],
});

describe("providersUsed", () => {
  it("counts each node's own model, the pipeline default, and the history summarizer", () => {
    assert.deepEqual([...providersUsed(local)], ["ollama"]);
    assert.deepEqual([...providersUsed(mixed)].sort(), ["ollama", "openai"]);
    const summarized: PipelineDefinition = {
      ...local,
      defaults: {},
      nodes: [{ id: "a", model: openai, prompt_template: "{{ message }}" }],
      output_nodes: ["a"],
      history: { summarize: { model: ollama } },
    };
    assert.deepEqual([...providersUsed(summarized)].sort(), ["ollama", "openai"]);
  });
});

describe("runOutage", () => {
  it("is null until the models are known, and while everything the pipeline uses is reachable", () => {
    assert.equal(runOutage(local, null), null);
    assert.equal(runOutage(local, models(true)), null);
  });

  it("ignores providers the pipeline doesn't use", () => {
    const cloud: PipelineDefinition = { ...local, defaults: {}, nodes: [{ id: "a", model: openai, prompt_template: "x" }], output_nodes: ["a"] };
    assert.equal(runOutage(cloud, models(false)), null);
  });

  it("blocks the run only when every model it uses is unreachable", () => {
    assert.equal(runOutage(local, models(false))?.blocksRun, true);
    assert.equal(runOutage(mixed, models(false))?.blocksRun, false);
  });
});

describe("outageMessage and runBlockedReason", () => {
  it("names the server's error and what it means for this pipeline", () => {
    assert.equal(outageMessage(runOutage(local, models(false))!), `${ERROR} — this pipeline can't run until it's back.`);
    assert.equal(outageMessage(runOutage(mixed, models(false))!), `${ERROR} — the nodes that use it will fail.`);
  });

  it("gives Run a reason only when the outage blocks it", () => {
    assert.equal(runBlockedReason(runOutage(local, models(false))), "Ollama is unreachable — start it to run");
    assert.equal(runBlockedReason(runOutage(mixed, models(false))), null);
    assert.equal(runBlockedReason(null), null);
  });
});
