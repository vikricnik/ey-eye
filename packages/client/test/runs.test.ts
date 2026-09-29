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
    await client.ask({ pipeline: "my-pipe", prompt: "q" });
    for await (const _event of client.askStream({ pipeline: "my-pipe", prompt: "q" })) void _event;
    assert.deepEqual(seen, [
      { request: "POST /v1/pipelines/my-pipe/runs", accept: "application/json", body: { prompt: "q", history: [] } },
      { request: "POST /v1/pipelines/my-pipe/runs", accept: "text/event-stream", body: { prompt: "q", history: [] } },
    ]);
  });

  it("sends only the run's own fields — the pipeline goes in the path", async () => {
    const client = new PipelineClient(base);
    // A caller's object may carry more than AskInput declares.
    const input = { pipeline: "p", prompt: "q", rerun: { from_node: "a", outputs: {} }, stray: 1 };
    await client.ask(input, { signal: new AbortController().signal });
    assert.deepEqual(seen[0]!.body, { prompt: "q", history: [], rerun: { from_node: "a", outputs: {} } });
  });

  it("works on unsaved definitions under /drafts", async () => {
    const client = new PipelineClient(base);
    const definition: PipelineDefinition = { name: "d", nodes: [], output_nodes: ["a"] };
    await client.validatePipeline({ format: "json", definition });
    await client.previewPrompt({ definition, node_id: "a" });
    for await (const _event of client.runTests({ definition })) void _event;
    assert.deepEqual(
      seen.map((s) => s.request),
      ["POST /v1/drafts/validation", "POST /v1/drafts/prompt-preview", "POST /v1/drafts/test-runs"]
    );
    assert.deepEqual(seen[0]!.body, { format: "json", definition });
  });

  it("validates a definition or a file's text, never both", () => {
    const definition: PipelineDefinition = { name: "d", nodes: [], output_nodes: ["a"] };
    const client = new PipelineClient(base);
    // Compile-time only: each request is exactly one of the two shapes.
    const _checks = () => [
      client.validatePipeline({ format: "yaml", text: "name: d" }),
      // @ts-expect-error — a definition's request has no text
      client.validatePipeline({ format: "json", definition, text: "name: d" }),
      // @ts-expect-error — a file's text isn't a definition
      client.validatePipeline({ format: "yaml", definition }),
      // @ts-expect-error — which format it is must be said
      client.validatePipeline({ definition }),
    ];
    void _checks;
  });
});
