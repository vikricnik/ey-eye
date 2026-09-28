import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { PipelineApiError } from "@llm-pipeline/client";
import { errorText, formatDuration, formatWhen, parseList } from "../src/format";

describe("formatting", () => {
  it("says how long ago, roughly", () => {
    const now = Date.UTC(2026, 8, 26, 12, 0);
    const ago = (minutes: number) => formatWhen(now - minutes * 60_000, now);
    assert.deepEqual([ago(0), ago(5), ago(150), ago(30 * 60)], ["just now", "5 min ago", "3 h ago", "yesterday"]);
    assert.equal(ago(3 * 24 * 60), new Date(now - 3 * 24 * 3_600_000).toLocaleDateString());
  });

  it("formats durations", () => {
    assert.equal(formatDuration(420), "420ms");
    assert.equal(formatDuration(1234), "1.2s");
  });

  it("prefers the server's own message", () => {
    const fromServer = new PipelineApiError("HTTP 422", {
      statusCode: 422,
      code: "DEFINITION_INVALID",
      serverMessage: "node 'a' has no model",
    });
    assert.equal(errorText(fromServer), "node 'a' has no model");
    assert.equal(errorText(new Error("boom")), "boom");
    assert.equal(errorText("plain"), "plain");
  });
});

describe("parseList", () => {
  it("splits on commas, trims, drops blanks, and gives undefined for nothing", () => {
    assert.deepEqual(parseList(" REFUND, TECHNICAL ,,GENERAL "), ["REFUND", "TECHNICAL", "GENERAL"]);
    assert.equal(parseList("  , "), undefined);
  });
});
