import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { explainRunFailure } from "../src/run/runFailure";

// The raw messages below are what the server actually sends (see
// providers/base.py ProviderError, providers/resilience.py, errors.py).
const nodeFailed = (cause: string) => ({
  code: "PIPELINE_RUN_FAILED" as const,
  message: `Node 'clasify' failed: ollama:llama3 failed: ${cause}`,
});

describe("explainRunFailure", () => {
  it("says a node couldn't reach Ollama, and how to start it", () => {
    for (const cause of [
      "All connection attempts failed",
      "Failed to connect to Ollama. Please check that Ollama is downloaded, running and accessible. https://ollama.com/download",
    ]) {
      const explained = explainRunFailure(nodeFailed(cause));
      assert.equal(explained?.summary, 'Node "clasify" couldn\'t reach Ollama.');
      assert.match(explained?.hint ?? "", /`ollama serve`/);
    }
  });

  it("names another provider when that's the one out of reach", () => {
    const explained = explainRunFailure({
      code: "PIPELINE_RUN_FAILED",
      message: "Node 'draft' failed: openai:gpt-4o failed: Connection refused",
    });
    assert.equal(explained?.summary, 'Node "draft" couldn\'t reach OpenAI.');
  });

  it("says which model to install when Ollama doesn't have it", () => {
    const explained = explainRunFailure(nodeFailed('model "llama3" not found, try pulling it first (status code: 404)'));
    assert.equal(explained?.summary, 'Ollama doesn\'t have the model "llama3" that node "clasify" uses.');
    assert.match(explained?.hint ?? "", /`ollama pull llama3`/);
  });

  it("reads an empty cause as the per-call timeout", () => {
    const explained = explainRunFailure(nodeFailed(""));
    assert.equal(explained?.summary, 'Node "clasify" got no answer from ollama:llama3 in time.');
    assert.match(explained?.hint ?? "", /timeout/);
  });

  it("explains the circuit breaker, with its cooldown", () => {
    const explained = explainRunFailure(
      nodeFailed("circuit open after 5+ consecutive failures — skipping call (cooldown 30.0s)")
    );
    assert.match(explained?.summary ?? "", /pausing calls to ollama:llama3/);
    assert.match(explained?.hint ?? "", /30 s/);
  });

  it("explains the run time limit and a run where no output node ran", () => {
    assert.equal(
      explainRunFailure({
        code: "RUN_TIMED_OUT",
        message: "the run took longer than its limit of 120s (execution.run_timeout_seconds)",
      })?.summary,
      "The run took longer than its 120 s limit."
    );
    assert.equal(
      explainRunFailure({
        code: "PIPELINE_RUN_FAILED",
        message: "Pipeline completed but none of its output_nodes (other) produced a result",
      })?.summary,
      "The run finished, but none of its output nodes ran."
    );
  });

  it("explains request-level failures by their code", () => {
    for (const code of ["RATE_LIMITED", "UNAUTHENTICATED", "INPUT_TOO_LARGE", "INTERNAL_ERROR"] as const) {
      assert.ok(explainRunFailure({ code, message: "whatever the server said" })?.hint, code);
    }
  });

  it("works on conversations saved before errors kept their code", () => {
    assert.equal(
      explainRunFailure({ message: "Node 'clasify' failed: ollama:llama3 failed: All connection attempts failed" })?.summary,
      'Node "clasify" couldn\'t reach Ollama.'
    );
  });

  it("leaves anything else to the raw message", () => {
    assert.equal(explainRunFailure({ code: "PIPELINE_RUN_FAILED", message: "Node 'x': its prompt can't be rendered: boom" }), null);
    assert.equal(explainRunFailure({ message: "Could not reach pipeline server at http://localhost:8000. Is it running?" }), null);
  });
});
