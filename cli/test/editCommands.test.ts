import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import type {
  NodePreset,
  PipelineClient,
  PipelineDefinition,
  RunTestsRequest,
  TestRunEvent,
} from "@llm-pipeline/client";
import { handleEditCommand } from "../src/editCommands.js";
import type { EditContext } from "../src/editCommands.js";

/** A draft session plus an in-memory stand-in for the server's saved
 * nodes, so the commands run end to end without a server. */
function setup(answer = "y") {
  const library = new Map<string, NodePreset>();
  const client = {
    listPresets: async () => ({ presets: [...library.values()] }),
    getPreset: async (name: string) => {
      const preset = library.get(name);
      if (!preset) throw new Error(`no saved node '${name}'`);
      return { preset, revision: "r" };
    },
    savePreset: async (preset: NodePreset) => {
      library.set(preset.name, preset);
      return { preset, revision: "r" };
    },
  } as unknown as PipelineClient;
  const draft: PipelineDefinition = {
    name: "p",
    nodes: [
      { id: "draft", depends_on: [], model: { provider: "ollama", model: "llama3" }, prompt_template: "{{ input }}" },
      {
        id: "critic",
        depends_on: ["draft"],
        model: { provider: "ollama", model: "gemma3:12b", temperature: 0.1, options: { num_ctx: 8192 } },
        system_prompt: "Be strict.",
        prompt_template: "Critique:\n{{ draft.output }}",
        include_history: false,
      },
    ],
    output_node: "critic",
  };
  const ctx: EditContext = {
    client,
    input: { ask: async () => answer, pause: () => undefined, resume: () => undefined },
    stoppable: (work) => work(new AbortController().signal),
    activePipeline: () => "p",
    switchPipeline: async () => undefined,
    defaultPipeline: async () => "p",
    session: { draft, baseRevision: "rev", dirty: false },
  };
  const run = (line: string) => handleEditCommand(ctx, line);
  return { ctx, library, run };
}

let printed: string[] = [];
const originalLog = console.log;
beforeEach(() => {
  printed = [];
  console.log = (...args: unknown[]) => void printed.push(args.join(" "));
});
afterEach(() => {
  console.log = originalLog;
});

describe("/dup", () => {
  it("copies a node with its settings and inputs", async () => {
    const { ctx, run } = setup();
    await run("/dup critic");
    const copy = ctx.session!.draft.nodes.find((n) => n.id === "critic_2")!;
    assert.deepEqual(copy.depends_on, ["draft"]);
    assert.equal(copy.system_prompt, "Be strict.");
    assert.equal(copy.include_history, false);
    assert.ok(ctx.session!.dirty);

    await run("/dup critic reviewer");
    assert.ok(ctx.session!.draft.nodes.some((n) => n.id === "reviewer"));
  });
});

describe("/library", () => {
  it("saves a node's whole configuration and adds it to another pipeline", async () => {
    const { ctx, library, run } = setup();
    await run("/library save critic strict-critic --description Checks a draft for errors");
    const saved = library.get("strict-critic")!;
    assert.equal(saved.description, "Checks a draft for errors");
    assert.deepEqual(saved.model, { provider: "ollama", model: "gemma3:12b", temperature: 0.1, options: { num_ctx: 8192 } });
    assert.equal(saved.prompt_template, "Critique:\n{{ draft.output }}");
    assert.equal(saved.include_history, false);

    // a fresh pipeline, starting from the saved node
    await run("/new other --from strict-critic");
    assert.equal(ctx.session!.draft.nodes[0]!.id, "strict_critic");
    assert.equal(ctx.session!.draft.output_node, "strict_critic");

    // …and a second copy after a node: its {{ draft.output }} now reads that node
    await run("/library add strict-critic --after strict_critic --id review");
    const review = ctx.session!.draft.nodes.find((n) => n.id === "review")!;
    assert.deepEqual(review.depends_on, ["strict_critic"]);
    assert.equal(review.prompt_template, "Critique:\n{{ strict_critic.output }}");
  });

  it("asks before replacing a saved node", async () => {
    const { library, run } = setup("n");
    await run("/library save critic");
    assert.equal(library.get("critic")!.model.model, "gemma3:12b", "saved under the node's id");
    await run("/set critic.model ollama:llama3");
    await run("/library save critic");
    assert.equal(library.get("critic")!.model.model, "gemma3:12b", "declined: not replaced");
    assert.ok(printed.some((l) => l.includes("not saved")));
  });

  it("lists and shows saved nodes", async () => {
    const { run } = setup();
    await run("/library save critic");
    printed = [];
    await run("/library");
    assert.ok(printed.some((l) => l.includes("critic") && l.includes("no history")));
    printed = [];
    await run("/library show critic");
    assert.ok(printed.join("\n").includes("Be strict."));
  });
});

describe("/test and /compare", () => {
  it("adds a case from answers to its questions", async () => {
    const { ctx, run } = setup();
    const answers = ["capital", "What is the capital of France?", "contains: Paris", "not: Berlin", "oops", "judge: one sentence", ""];
    ctx.input = { ask: async () => answers.shift() ?? null, pause: () => undefined, resume: () => undefined };
    await run("/test add");
    assert.deepEqual(ctx.session!.draft.tests, {
      cases: [
        {
          name: "capital",
          input: "What is the capital of France?",
          expect: [{ contains: "Paris" }, { not_contains: "Berlin" }, { judge: "one sentence" }],
        },
      ],
    });
    assert.ok(printed.some((l) => l.includes("/test judge")), "hints that a judge model is needed");
    await run("/test judge ollama:llama3.2:3b");
    // (deepEqual above narrowed the draft's type; read it afresh)
    const draft = (): PipelineDefinition => ctx.session!.draft;
    assert.equal(draft().tests?.judge?.model.model, "llama3.2:3b");
    await run("/test rm capital");
    assert.equal(draft().tests?.cases, undefined);
  });

  it("compares models for a node on every case of the draft", async () => {
    const { ctx, run } = setup();
    let sent: RunTestsRequest | undefined;
    (ctx.client as unknown as { runTests: (r: RunTestsRequest) => AsyncGenerator<TestRunEvent> }).runTests =
      async function* (request: RunTestsRequest) {
        sent = request;
        yield {
          type: "case_result",
          data: { case: "c", variant: "llama3.2:3b", passed: true, expectations: [], duration_ms: 1200, prompt_tokens: 5, completion_tokens: 5 },
        };
        yield {
          type: "tests_done",
          data: {
            summaries: [
              { variant: "llama3.2:3b", passed: 1, failed: 0, errors: 0, unchecked: 0, duration_ms: 1200, prompt_tokens: 5, completion_tokens: 5 },
            ],
          },
        };
      };
    await run("/compare critic ollama:llama3.2:3b");
    assert.equal(sent!.definition, ctx.session!.draft, "runs the draft, unsaved");
    assert.deepEqual(sent!.variants, [
      { label: "llama3.2:3b", models: { critic: { provider: "ollama", model: "llama3.2:3b" } } },
    ]);
    assert.ok(printed.some((l) => l.includes("1/1 passed")));
    await run("/compare nope ollama:x");
    assert.ok(printed.some((l) => l.includes("nope")), "unknown node is reported");
  });
});

describe("/node <id>", () => {
  it("shows a classifier's labels, and no labels line for other nodes", async () => {
    const { ctx, run } = setup();
    ctx.session!.draft.nodes[0]!.labels = ["REFUND", "TECHNICAL"];

    await run("/node draft");
    const shown = printed.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(shown, /labels:\s+REFUND, TECHNICAL — answers exactly one/);

    printed = [];
    await run("/node critic");
    assert.doesNotMatch(printed.join("\n"), /labels:/);
  });
});
