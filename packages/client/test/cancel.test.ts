import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { PipelineClient, RequestCancelledError } from "../src/apiClient.js";

/** A server that starts a run and never finishes it — like a model that's
 * still generating — and records when the client hangs up. */
let server: Server;
let base = "";
let hangUps = 0;

before(async () => {
  server = createServer((req, res) => {
    req.on("close", () => hangUps++);
    req.resume();
    if (req.headers.accept === "text/event-stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = req.url === "/drafts/test-runs" ? "case_start" : "node_start";
      res.write(`event: ${event}\ndata: {"node_id": "a", "model_name": "m", "case": "c", "variant": "current"}\n\n`);
      return; // …and never another byte
    }
    // an answered run: no answer until the client gives up
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

async function hungUp(before: number): Promise<void> {
  for (let i = 0; i < 100 && hangUps === before; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(hangUps > before, "the server saw the client hang up");
}

describe("stopping a request", () => {
  it("stops a streaming run, and the server sees the connection close", async () => {
    const client = new PipelineClient(base);
    const stop = new AbortController();
    const seen: string[] = [];
    const count = hangUps;
    await assert.rejects(
      (async () => {
        for await (const event of client.askStream("q", "p", [], { signal: stop.signal })) {
          seen.push(event.type);
          stop.abort();
        }
      })(),
      RequestCancelledError
    );
    assert.deepEqual(seen, ["node_start"]);
    await hungUp(count);
  });

  it("stops a plain request and a test run", async () => {
    const client = new PipelineClient(base);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 30);
    await assert.rejects(client.ask("q", "p", [], { signal: stop.signal }), RequestCancelledError);

    const stopTests = new AbortController();
    await assert.rejects(
      (async () => {
        for await (const _ of client.runTests({ definition: { name: "p", nodes: [], output_node: "a" } }, { signal: stopTests.signal })) {
          stopTests.abort();
        }
      })(),
      RequestCancelledError
    );
  });

  it("hangs up when the caller stops reading early", async () => {
    const client = new PipelineClient(base);
    const count = hangUps;
    for await (const _ of client.askStream("q", "p")) break;
    await hungUp(count);
  });

  it("doesn't send the signal to the server", async () => {
    let body = "";
    const echo = createServer((req, res) => {
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ pipeline_name: "p", output_node: "a", final_answer: "x", node_outputs: {}, loop_iterations: {} }));
      });
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const client = new PipelineClient(`http://127.0.0.1:${(echo.address() as AddressInfo).port}`);
    await client.ask("q", "p", [], { signal: new AbortController().signal });
    echo.close();
    assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ["history", "prompt"]);
  });
});
