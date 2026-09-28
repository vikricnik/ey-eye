import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { PipelineClient } from "../src/apiClient.js";
import type { PipelineDefinition } from "../src/types.js";

interface Seen {
  request: string;
  accept: string | undefined;
  body: unknown;
}

/** Records each request; answers a streamed request with a `done` event
 * and anything else with an empty JSON object. */
let server: Server;
let base = "";
let seen: Seen[] = [];

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({
        request: `${req.method} ${req.url}`,
        accept: req.headers.accept,
        body: body ? (JSON.parse(body) as unknown) : undefined,
      });
      if (req.headers.accept === "text/event-stream") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end('event: done\ndata: {"final_answer": "a"}\n\n');
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  seen = [];
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe("runs", () => {
  it("runs a pipeline at its own path, answered or streamed by Accept", async () => {
    const client = new PipelineClient(base);
    await client.ask("q", "my-pipe", []);
    for await (const _event of client.askStream("q", "my-pipe", [])) void _event;
    assert.deepEqual(seen, [
      { request: "POST /pipelines/my-pipe/runs", accept: "application/json", body: { prompt: "q", history: [] } },
      { request: "POST /pipelines/my-pipe/runs", accept: "text/event-stream", body: { prompt: "q", history: [] } },
    ]);
  });

  it("works on unsaved definitions under /drafts", async () => {
    const client = new PipelineClient(base);
    const definition: PipelineDefinition = { name: "d", nodes: [], output_node: "a" };
    await client.validatePipeline({ definition });
    await client.previewPrompt({ definition, node_id: "a" });
    for await (const _event of client.runTests({ definition })) void _event;
    assert.deepEqual(
      seen.map((s) => s.request),
      ["POST /drafts/validation", "POST /drafts/prompt-preview", "POST /drafts/test-runs"]
    );
  });
});
