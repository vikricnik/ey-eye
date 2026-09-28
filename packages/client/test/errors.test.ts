import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { PipelineApiError, PipelineClient, ServerUnreachableError } from "../src/apiClient.js";
import type { ApiErrorBody } from "../src/types.js";

function errorBody(status: number, code: ApiErrorBody["code"], message: string, details = {}): ApiErrorBody {
  return {
    timestamp: "2026-09-28T00:00:00Z",
    status,
    error: "Error",
    code,
    message,
    request: "-",
    exceptionUID: "ref123",
    details,
    validations: [],
  };
}

/** Answers every save with "already exists", and every streamed run with a
 * failure after it started. */
let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    if (req.headers.accept === "text/event-stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const failure = errorBody(502, "PIPELINE_RUN_FAILED", "Node 'a' failed", { node_id: "a" });
      res.end(`event: error\ndata: ${JSON.stringify(failure)}\n\n`);
      return;
    }
    res.writeHead(412, { "Content-Type": "application/json" });
    res.end(JSON.stringify(errorBody(412, "ALREADY_EXISTS", "pipeline 'fresh' already exists")));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function rejection(promise: Promise<unknown>): Promise<PipelineApiError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof PipelineApiError);
    return err;
  }
  assert.fail("expected a PipelineApiError");
}

describe("error codes", () => {
  it("are exposed on a failed request", async () => {
    const client = new PipelineClient(base);
    const err = await rejection(client.createPipeline({ name: "fresh", nodes: [], output_node: "a" }));
    assert.equal(err.code, "ALREADY_EXISTS");
    assert.equal(err.statusCode, 412);
    assert.equal(err.serverMessage, "pipeline 'fresh' already exists");
    assert.equal(err.exceptionUID, "ref123");
  });

  it("are exposed on a failure mid-stream, like any other error", async () => {
    const client = new PipelineClient(base);
    const seen: string[] = [];
    const err = await rejection(
      (async () => {
        for await (const event of client.askStream({ pipeline: "p", prompt: "q" })) seen.push(event.type);
      })()
    );
    assert.deepEqual(seen, []);
    assert.equal(err.code, "PIPELINE_RUN_FAILED");
    assert.equal(err.statusCode, 502);
    assert.equal(err.serverMessage, "Node 'a' failed");
    assert.deepEqual(err.details, { node_id: "a" });
  });
});

describe("an unreachable server", () => {
  it("is its own error type, not an API error with no status", async () => {
    // A port that was just free: nothing is listening on it.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const client = new PipelineClient(`http://127.0.0.1:${port}`);

    for (const call of [
      () => client.listPipelines(),
      async () => {
        for await (const _event of client.askStream({ pipeline: "p", prompt: "q" })) void _event;
      },
    ]) {
      const err = await rejection(call());
      assert.ok(err instanceof ServerUnreachableError);
      assert.match(err.message, new RegExp(`127\\.0\\.0\\.1:${port}`));
    }
  });
});
