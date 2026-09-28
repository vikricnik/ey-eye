import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { PipelineApiError, PipelineClient } from "../src/apiClient.js";
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
    if (req.url === "/ask/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const failure = errorBody(503, "PIPELINE_RUN_FAILED", "Node 'a' failed", { node_id: "a" });
      res.end(`event: error\ndata: ${JSON.stringify(failure)}\n\n`);
      return;
    }
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify(errorBody(409, "PIPELINE_EXISTS", "pipeline 'fresh' already exists")));
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
    const err = await rejection(client.savePipeline({ name: "fresh", nodes: [], output_node: "a" }, null));
    assert.equal(err.code, "PIPELINE_EXISTS");
    assert.equal(err.statusCode, 409);
    assert.equal(err.serverMessage, "pipeline 'fresh' already exists");
    assert.equal(err.exceptionUID, "ref123");
  });

  it("are exposed on a failure mid-stream, like any other error", async () => {
    const client = new PipelineClient(base);
    const seen: string[] = [];
    const err = await rejection(
      (async () => {
        for await (const event of client.askStream("q", "p")) seen.push(event.type);
      })()
    );
    assert.deepEqual(seen, []);
    assert.equal(err.code, "PIPELINE_RUN_FAILED");
    assert.equal(err.statusCode, 503);
    assert.equal(err.serverMessage, "Node 'a' failed");
    assert.deepEqual(err.details, { node_id: "a" });
  });
});
