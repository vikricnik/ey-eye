import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, it } from "node:test";

import { PipelineClient } from "../src/apiClient.js";
import type { NodePreset, PipelineDefinition } from "../src/types.js";

interface Seen {
  request: string;
  ifMatch: string | undefined;
  ifNoneMatch: string | undefined;
  body: unknown;
}

/** Records each request's precondition headers and body, and answers with
 * something shaped enough for the client to return. */
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
        ifMatch: req.headers["if-match"],
        ifNoneMatch: req.headers["if-none-match"],
        body: body ? (JSON.parse(body) as unknown) : undefined,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ definition: {}, preset: {}, revision: "r2", name: "p", recoverable_as: "x" }));
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

const definition: PipelineDefinition = { name: "p", nodes: [], output_nodes: ["a"] };
const preset: NodePreset = { name: "n", model: { provider: "ollama", name: "m" } };

describe("preconditions", () => {
  it("creates a pipeline with If-None-Match: * and updates it with If-Match", async () => {
    const client = new PipelineClient(base);
    await client.createPipeline(definition);
    await client.updatePipeline(definition, { baseRevision: "r1" });
    assert.deepEqual(seen, [
      { request: "PUT /v1/pipelines/p", ifMatch: undefined, ifNoneMatch: "*", body: { definition } },
      { request: "PUT /v1/pipelines/p", ifMatch: '"r1"', ifNoneMatch: undefined, body: { definition } },
    ]);
  });

  it("deletes with If-Match when given the revision, unconditionally otherwise", async () => {
    const client = new PipelineClient(base);
    await client.deletePipeline("p", "r1");
    await client.deletePipeline("p");
    assert.deepEqual(
      seen.map((s) => [s.request, s.ifMatch]),
      [
        ["DELETE /v1/pipelines/p", '"r1"'],
        ["DELETE /v1/pipelines/p", undefined],
      ]
    );
  });

  it("guards preset writes only when asked to", async () => {
    const client = new PipelineClient(base);
    await client.savePreset(preset);
    await client.savePreset(preset, "r1");
    await client.deletePreset("n", "r1");
    assert.deepEqual(
      seen.map((s) => [s.request, s.ifMatch]),
      [
        ["PUT /v1/presets/n", undefined],
        ["PUT /v1/presets/n", '"r1"'],
        ["DELETE /v1/presets/n", '"r1"'],
      ]
    );
  });
});
