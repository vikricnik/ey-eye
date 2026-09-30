import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  defaultsSummary,
  executionSummary,
  historySummary,
  outputSummary,
  routingSummary,
} from "../src/editor/pipelineSummaries";

describe("outputSummary", () => {
  it("names the one output node", () => {
    assert.equal(outputSummary(["other"]), "answer from other");
  });

  it("lists several in priority order — the first that ran answers", () => {
    assert.equal(outputSummary(["other", "joke"]), "other, joke — first that ran");
  });
});

describe("executionSummary", () => {
  it("says the server's defaults apply when nothing is set", () => {
    assert.equal(executionSummary(undefined), "server defaults");
    assert.equal(executionSummary({}), "server defaults");
  });

  it("lists only what's set, in the order the fields appear", () => {
    assert.equal(executionSummary({ model_timeout_seconds: 120, max_retries: 2 }), "timeout 120 s · 2 retries");
    assert.equal(
      executionSummary({
        model_timeout_seconds: 60,
        run_timeout_seconds: 300,
        max_concurrency: 4,
        max_retries: 1,
        retry_backoff_seconds: 2,
      }),
      "timeout 60 s · run limit 300 s · 4 parallel · 1 retry · backoff 2 s"
    );
  });

  it("counts 0 retries as set", () => {
    assert.equal(executionSummary({ max_retries: 0 }), "0 retries");
  });
});

describe("historySummary", () => {
  it("keeps 6 turns when nothing is set — the server's default", () => {
    assert.equal(historySummary(undefined), "6 turns");
    assert.equal(historySummary({}), "6 turns");
  });

  it("is off with 0 turns", () => {
    assert.equal(historySummary({ max_turns: 0, max_chars: 4000 }), "off");
  });

  it("adds the budget, the remembered nodes and the summarizer", () => {
    assert.equal(
      historySummary({
        max_turns: 1,
        max_chars: 4000,
        remember: ["clasify", "other"],
        summarize: { model: { provider: "ollama", name: "llama3" } },
      }),
      "1 turn · 4000 chars · remembers clasify, other · summarized by llama3"
    );
  });
});

describe("defaultsSummary", () => {
  it("says every node sets its own when there are no defaults", () => {
    assert.equal(defaultsSummary(undefined), "none — every node sets its own");
    assert.equal(defaultsSummary({}), "none — every node sets its own");
  });

  it("names the model, its temperature, and what else nodes inherit", () => {
    assert.equal(
      defaultsSummary({
        model: { provider: "ollama", name: "llama3", temperature: 0.2 },
        system_prompt: "Be brief.",
        strip_reasoning: true,
      }),
      "ollama:llama3 · T 0.2 · system prompt · strips reasoning"
    );
  });

  it("works without a default model", () => {
    assert.equal(defaultsSummary({ system_prompt: "Be brief." }), "system prompt");
  });
});

describe("routingSummary", () => {
  it("counts branches and loops", () => {
    assert.equal(routingSummary(1, 0), "1 branch");
    assert.equal(routingSummary(2, 1), "2 branches · 1 loop");
    assert.equal(routingSummary(0, 3), "3 loops");
  });
});
