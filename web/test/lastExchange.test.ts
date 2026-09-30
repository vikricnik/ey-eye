import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { lastExchange } from "../src/run/lastExchange";
import type { Turn } from "../src/run/Chat";

const turn = (fields: Partial<Turn>) =>
  ({ id: 1, pipeline: "p", prompt: "Why short functions?", history: [], status: "done", nodeOutputs: [], log: [], ...fields }) as Turn;

describe("lastExchange", () => {
  it("is nothing before the first message", () => {
    assert.equal(lastExchange([], undefined), null);
  });

  it("gives the latest message and its answer", () => {
    const done = turn({ status: "done", result: { final_answer: "They do one thing." } as Turn["result"] });
    assert.deepEqual(lastExchange([turn({ prompt: "older" }), done], undefined), {
      prompt: "Why short functions?",
      answer: "They do one thing.",
      state: "done",
    });
  });

  it("shows the answer as it streams", () => {
    assert.deepEqual(lastExchange([turn({ status: "running" })], "They do"), { prompt: "Why short functions?", answer: "They do", state: "running" });
    assert.deepEqual(lastExchange([turn({ status: "running" })], undefined), { prompt: "Why short functions?", answer: "", state: "running" });
  });

  it("says when the run was stopped or failed", () => {
    assert.deepEqual(lastExchange([turn({ status: "stopped" })], undefined), {
      prompt: "Why short functions?",
      answer: "stopped — nothing from this run was added",
      state: "stopped",
    });
    assert.deepEqual(lastExchange([turn({ status: "error", error: { message: "Ollama is down" } })], undefined), {
      prompt: "Why short functions?",
      answer: "failed — Ollama is down",
      state: "failed",
    });
  });
});
