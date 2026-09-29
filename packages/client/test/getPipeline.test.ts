import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { PipelineClient } from "../src/apiClient.js";
import type { PipelineDefinitionResponse } from "../src/types.js";

const stored: PipelineDefinitionResponse = {
  definition: { name: "my-pipe", nodes: [{ id: "a", prompt_template: "{{ input }}" }], output_nodes: ["a"] },
  revision: "0123456789abcdef",
  has_comments: false,
};

let server: Server;
let base = "";
const requested: string[] = [];

before(async () => {
  server = createServer((req, res) => {
    req.resume();
    requested.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(stored));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe("listModels", () => {
  it("uses the server's short cache unless asked to refresh", async () => {
    requested.length = 0;
    const client = new PipelineClient(base);
    await client.listModels();
    await client.listModels({ refresh: true });
    assert.deepEqual(requested, ["GET /v1/models", "GET /v1/models?refresh=true"]);
  });
});

describe("checkHealth", () => {
  it("probes /health, which stays outside the API's version", async () => {
    requested.length = 0;
    await new PipelineClient(base).checkHealth();
    assert.deepEqual(requested, ["GET /health"]);
  });
});

describe("getPipeline", () => {
  it("reads the pipeline itself — the definition and revision a save takes back", async () => {
    requested.length = 0;
    const loaded = await new PipelineClient(base).getPipeline("my-pipe");
    assert.deepEqual(requested, ["GET /v1/pipelines/my-pipe"]);
    assert.deepEqual(loaded, stored);
  });
});
