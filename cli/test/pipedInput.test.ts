import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

/**
 * The CLI fed from a pipe: every line runs, in order — including lines that
 * arrive while an earlier one is still running — and the end of the input
 * ends the CLI cleanly. (readline's question() used to drop those lines and
 * then crash with ERR_USE_AFTER_CLOSE.)
 */

let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const json = (data: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url === "/v1/server-info") {
        return json({ default_pipeline_name: "p", editing_enabled: false, editing_disabled_reason: null });
      }
      if (req.url === "/v1/workflows") {
        return json({ pipelines: [{ name: "p", description: "", filename: "p.yaml" }] });
      }
      if (req.url === "/v1/workflows/p") {
        return json({
          definition: {
            name: "p",
            nodes: [{ id: "a", prompt_template: "{{ input }}", model: { provider: "ollama", name: "m" } }],
            output_nodes: ["a"],
          },
          revision: "0000000000000000",
          has_comments: false,
        });
      }
      if (req.url === "/v1/workflows/p/runs") {
        const { prompt } = JSON.parse(body) as { prompt: string };
        // Slow enough that the next piped line arrives mid-run.
        setTimeout(
          () =>
            json({
              pipeline_name: "p",
              output_node: "a",
              final_answer: `answer to ${prompt}`,
              node_outputs: { a: { node_id: "a", model_name: "ollama:m", output: `answer to ${prompt}`, duration_ms: 1 } },
              loop_iterations: {},
            }),
          150
        );
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

function runCli(stdinText: string): Promise<{ code: number | null; output: string }> {
  const entry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      env: { ...process.env, PIPELINE_BASE_URL: base, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the CLI didn't exit; output so far:\n${output}`));
    }, 20_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
    child.stdin.end(stdinText); // all at once, then end of input
  });
}

describe("piped input", () => {
  it("runs every line in order and exits cleanly at the end of the input", async () => {
    const { code, output } = await runCli("first question\n/verbose\nsecond question\n");
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /fatal error|ERR_USE_AFTER_CLOSE/);
    const first = output.indexOf("answer to first question");
    const verbose = output.indexOf("verbose mode: on");
    const second = output.indexOf("answer to second question");
    assert.ok(first >= 0 && verbose > first && second > verbose, output);
    assert.match(output, /goodbye/);
  });
});
