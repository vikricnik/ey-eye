import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DraftError,
  addNode,
  applyPreset,
  connect,
  disconnect,
  duplicateNode,
  effectiveModel,
  expectationParts,
  makeExpectation,
  removeTestCase,
  setTestJudge,
  uniqueCaseName,
  upsertTestCase,
  newDefinition,
  modelIdentity,
  parseModelIdentity,
  presetFromNode,
  removeNode,
  renameNode,
  renameTemplateRefs,
  modelWithIdentity,
  modelWithOption,
  setNodeModel,
  setNodeProperty,
  setOutput,
  setPipelineSetting,
  updateNodeModel,
  templateNodeRefs,
  uniqueNodeId,
} from "../src/draftOps.js";
import type { PipelineDefinition } from "../src/types.js";
import { routeTargets } from "../src/types.js";

function diamond(): PipelineDefinition {
  return {
    name: "d",
    nodes: [
      { id: "a", depends_on: [], model: { provider: "ollama", name: "llama3" }, prompt_template: "{{ input }}" },
      { id: "b", depends_on: ["a"], model: { provider: "ollama", name: "llama3" }, prompt_template: "B {{ a.output }}" },
      { id: "c", depends_on: ["a"], model: { provider: "ollama", name: "llama3" }, prompt_template: "C {{a.output}}" },
      {
        id: "d",
        depends_on: ["b", "c"],
        model: { provider: "ollama", name: "llama3", options: { num_ctx: 4096 } },
        prompt_template: "{{ b.output }} / {{ c.output }} {% if b is defined %}x{% endif %}",
      },
    ],
    loops: [{ id: "l", from: "d", back_to: "b", exit_to: "END", exit_when: "True" }],
    branches: [{ id: "br", from: "a", routes: [{ when: "'x' in output", to: "b" }, { default: true, to: "c" }] }],
    output_nodes: ["d"],
  };
}

describe("addNode", () => {
  it("adds a dependent node whose prompt references its inputs", () => {
    const { definition, id } = addNode(diamond(), { after: ["b", "c"], id: "summary" });
    assert.equal(id, "summary");
    const node = definition.nodes.at(-1)!;
    assert.deepEqual(node.depends_on, ["b", "c"]);
    assert.equal(node.prompt_template, "{{ conversation }}\n\n{{ b.output }}\n\n{{ c.output }}");
    assert.equal(diamond().nodes.length, 4, "input is not mutated");
  });

  it("generates unique ids and rejects bad or duplicate ones", () => {
    const def = diamond();
    assert.equal(uniqueNodeId(def, "a"), "a_2");
    assert.equal(uniqueNodeId(def, "my preset"), "my_preset");
    assert.throws(() => addNode(def, { id: "a" }), DraftError);
    assert.throws(() => addNode(def, { id: "1bad" }), DraftError);
    assert.throws(() => addNode(def, { after: ["nope"] }), DraftError);
  });
});

describe("removeNode", () => {
  it("removes every structural reference", () => {
    const def = removeNode(diamond(), "b");
    assert.deepEqual(def.nodes.map((n) => n.id), ["a", "c", "d"]);
    assert.deepEqual(def.nodes.find((n) => n.id === "d")!.depends_on, ["c"]);
    assert.deepEqual(def.loops, [], "loop back_to b is gone");
    assert.deepEqual(def.branches![0]!.routes, [{ default: true, to: "c" }]);
    // Template text is left for the server's validation to flag.
    assert.match(def.nodes.find((n) => n.id === "d")!.prompt_template, /b\.output/);
  });

  it("falls back to a sink when the output node is removed", () => {
    const def = removeNode(diamond(), "d");
    assert.deepEqual(def.output_nodes, ["c"]);
  });

  it("refuses to remove the last node", () => {
    assert.throws(() => removeNode(newDefinition("x", { provider: "ollama", name: "m" }), "answer"), DraftError);
  });
});

describe("multi-target routes", () => {
  function fanOut(): PipelineDefinition {
    const def = diamond();
    return { ...def, branches: [{ id: "br", from: "a", routes: [{ when: "'x' in output", to: ["b", "c"] }, { default: true, to: "d" }] }] };
  }

  it("removing one target keeps the route, collapsing a single survivor to a plain id", () => {
    assert.deepEqual(removeNode(fanOut(), "b").branches![0]!.routes[0], { when: "'x' in output", to: "c" });
  });

  it("renaming a node renames it inside target lists", () => {
    assert.deepEqual(renameNode(fanOut(), "c", "check").branches![0]!.routes[0]!.to, ["b", "check"]);
  });

  it("routeTargets flattens either form", () => {
    assert.deepEqual(routeTargets({ to: "b" }), ["b"]);
    assert.deepEqual(routeTargets({ to: ["b", "c"] }), ["b", "c"]);
  });
});

describe("renameNode", () => {
  it("renames the node in deps, templates, branches, loops and outputs", () => {
    const def = renameNode(diamond(), "b", "critic");
    const d = def.nodes.find((n) => n.id === "d")!;
    assert.deepEqual(d.depends_on, ["critic", "c"]);
    assert.equal(d.prompt_template, "{{ critic.output }} / {{ c.output }} {% if critic is defined %}x{% endif %}");
    assert.equal(def.loops![0]!.back_to, "critic");
    assert.equal(def.branches![0]!.routes[0]!.to, "critic");
    assert.deepEqual(renameNode(diamond(), "d", "final").output_nodes, ["final"]);
  });

  it("only rewrites real references, not look-alike words", () => {
    assert.equal(renameTemplateRefs("a b.output ab.output b_x.output", "b", "z"), "a z.output ab.output b_x.output");
    assert.equal(renameTemplateRefs("{{b . output}}", "b", "z"), "{{z . output}}");
  });

  it("rejects clashes", () => {
    assert.throws(() => renameNode(diamond(), "b", "c"), DraftError);
  });
});

describe("edges", () => {
  it("connect/disconnect edit depends_on idempotently", () => {
    let def = connect(diamond(), "b", "c");
    assert.deepEqual(def.nodes.find((n) => n.id === "c")!.depends_on, ["a", "b"]);
    def = connect(def, "b", "c");
    assert.deepEqual(def.nodes.find((n) => n.id === "c")!.depends_on, ["a", "b"]);
    def = disconnect(def, "a", "c");
    assert.deepEqual(def.nodes.find((n) => n.id === "c")!.depends_on, ["b"]);
    assert.throws(() => connect(def, "c", "c"), DraftError);
  });
});

describe("typed node edits", () => {
  it("sets and clears a node's own properties", () => {
    let def = setNodeProperty(diamond(), "a", "system_prompt", "Be terse.");
    def = setNodeProperty(def, "a", "include_history", false);
    assert.equal(def.nodes[0]!.system_prompt, "Be terse.");
    assert.equal(def.nodes[0]!.include_history, false);
    def = setNodeProperty(def, "a", "system_prompt", undefined);
    assert.equal("system_prompt" in def.nodes[0]!, false, "cleared, not left as undefined");
  });

  it("tunes a node's own model, dropping an emptied options block", () => {
    let def = updateNodeModel(diamond(), "a", (m) => ({ ...m, temperature: 0.7 }));
    def = updateNodeModel(def, "a", (m) => modelWithOption(m, "num_ctx", 8192));
    assert.equal(def.nodes[0]!.model!.temperature, 0.7);
    assert.deepEqual(def.nodes[0]!.model!.options, { num_ctx: 8192 });
    def = updateNodeModel(def, "a", (m) => modelWithOption(m, "num_ctx", undefined));
    assert.equal(def.nodes[0]!.model!.options, undefined, "empty options object removed");
  });

  it("switching model provider drops Ollama-only options", () => {
    const current = diamond().nodes[3]!.model;
    // No temperature was set, so none is invented: it stays "inherit".
    assert.deepEqual(modelWithIdentity(current, "openai:gpt-4o"), { provider: "openai", name: "gpt-4o" });
    assert.deepEqual(modelWithIdentity(current, "gemma3:12b").options, { num_ctx: 4096 });
  });

  it("only a node with its own model can be tuned", () => {
    const inherits: PipelineDefinition = {
      ...diamond(),
      defaults: { model: { provider: "ollama", name: "base" } },
    };
    const def = setNodeModel(inherits, "a", undefined);
    assert.throws(() => updateNodeModel(def, "a", (m) => ({ ...m, temperature: 1 })), DraftError);
  });

  it("makes misuse a compile-time error", () => {
    const def = diamond();
    // Never called: these lines only have to fail to type-check.
    void (() => {
      // @ts-expect-error — a node's prompt template can't be cleared
      setNodeProperty(def, "a", "prompt_template", undefined);
      // @ts-expect-error — renaming updates every reference: renameNode()
      setNodeProperty(def, "a", "id", "b");
      // @ts-expect-error — the model has its own operations (inheritance)
      setNodeProperty(def, "a", "model", undefined);
      // @ts-expect-error — `nodes` isn't a settings section
      setPipelineSetting(def, "nodes", "x", 1);
      // @ts-expect-error — a setting takes its own type
      setPipelineSetting(def, "execution", "max_concurrency", "2");
    });
  });
});

describe("models and presets", () => {
  it("parses model identities", () => {
    assert.deepEqual(parseModelIdentity("ollama:gemma3:12b"), { provider: "ollama", name: "gemma3:12b" });
    assert.deepEqual(parseModelIdentity("gemma3:12b"), { provider: "ollama", name: "gemma3:12b" });
    assert.deepEqual(parseModelIdentity("anthropic:claude-x"), { provider: "anthropic", name: "claude-x" });
  });

  it("an identity is a model's, never a stand-in label", () => {
    assert.equal(modelIdentity(parseModelIdentity("ollama:gemma3:12b")), "ollama:gemma3:12b");
    // Compile-time only: no model, no identity — callers choose their own label.
    // @ts-expect-error
    const _noModel = () => modelIdentity(undefined);
    void _noModel;
  });

  it("applying a preset copies values, not a reference", () => {
    const preset = presetFromNode(diamond(), "d", "ctx", { description: "long context", includePrompt: false });
    let def = applyPreset(diamond(), "a", preset);
    assert.deepEqual(def.nodes[0]!.model!.options, { num_ctx: 4096 });
    preset.model.options!.num_ctx = 1;
    assert.equal(def.nodes[0]!.model!.options!.num_ctx, 4096);
    assert.equal(def.nodes[0]!.prompt_template, "{{ input }}", "prompt untouched when the preset has none");

    def = addNode(def, { preset: { ...preset, name: "ctx" } }).definition;
    assert.equal(def.nodes.at(-1)!.id, "ctx");
  });

  it("setOutput validates ids", () => {
    assert.deepEqual(setOutput(diamond(), ["b", "c"]).output_nodes, ["b", "c"]);
    assert.deepEqual(setOutput(diamond(), ["c"]).output_nodes, ["c"]);
    assert.throws(() => setOutput(diamond(), "zzz"), DraftError);
  });
});

describe("duplicating nodes", () => {
  it("copies every setting and the inputs under a new id, beside the original", () => {
    const def = setNodeProperty(setNodeProperty(diamond(), "b", "include_history", false), "b", "layout", { x: 10, y: 170 });
    const { definition, id } = duplicateNode(def, "b");
    assert.equal(id, "b_2");
    const copy = definition.nodes.find((n) => n.id === "b_2")!;
    assert.deepEqual(copy.depends_on, ["a"]);
    assert.equal(copy.prompt_template, "B {{ a.output }}");
    assert.equal(copy.include_history, false);
    assert.deepEqual(copy.layout, { x: 270, y: 170 });
    assert.deepEqual(definition.nodes.map((n) => n.id), ["a", "b", "b_2", "c", "d"], "listed after the original");
    // nothing depends on the copy, and branches/loops/output stay put
    assert.deepEqual(definition.nodes.find((n) => n.id === "d")!.depends_on, ["b", "c"]);
    assert.deepEqual(definition.output_nodes, ["d"]);
    assert.equal(definition.loops!.length, 1);
    copy.model!.name = "changed";
    assert.equal(definition.nodes.find((n) => n.id === "b")!.model!.name, "llama3", "a copy, not shared objects");
  });

  it("numbers copies of copies from the same base and accepts an explicit id", () => {
    let def = duplicateNode(diamond(), "b").definition;
    assert.equal(duplicateNode(def, "b_2").id, "b_3");
    def = duplicateNode(def, "b", { id: "critic", layout: { x: 0, y: 0 } }).definition;
    assert.deepEqual(def.nodes.find((n) => n.id === "critic")!.layout, { x: 0, y: 0 });
    assert.throws(() => duplicateNode(def, "b", { id: "critic" }), DraftError);
    assert.throws(() => duplicateNode(def, "nope"), DraftError);
  });
});

describe("saved nodes (presets)", () => {
  it("capture what the node really runs with, prompt included", () => {
    const def: PipelineDefinition = {
      ...diamond(),
      defaults: {
        model: { provider: "ollama", name: "base", temperature: 0.6, options: { keep_alive: "10m" } },
        system_prompt: "Be brief.",
        strip_reasoning: true,
      },
      nodes: diamond().nodes.map((n) =>
        n.id === "b" ? { id: "b", depends_on: ["a"], prompt_template: "B {{ a.output }}", include_history: false } : n
      ),
    };
    assert.deepEqual(presetFromNode(def, "b", "critic", { description: "  checks drafts " }), {
      name: "critic",
      description: "checks drafts",
      model: { provider: "ollama", name: "base", temperature: 0.6, options: { keep_alive: "10m" } },
      system_prompt: "Be brief.",
      prompt_template: "B {{ a.output }}",
      include_history: false,
      strip_reasoning: true,
    });
    assert.throws(() => presetFromNode(def, "b", "bad name"), DraftError);
    assert.throws(() => presetFromNode({ ...diamond(), nodes: [{ id: "x", prompt_template: "" }] }, "x", "x"), DraftError);
  });

  it("applying one replaces the node's settings but keeps its id and inputs", () => {
    let def = setNodeProperty(diamond(), "c", "system_prompt", "old system");
    def = setNodeProperty(def, "c", "strip_reasoning", true);
    def = applyPreset(def, "c", {
      name: "p",
      model: { provider: "ollama", name: "gemma3:12b" },
      include_history: false,
    });
    const c = def.nodes.find((n) => n.id === "c")!;
    assert.deepEqual(c.model, { provider: "ollama", name: "gemma3:12b" });
    assert.equal(c.system_prompt, undefined, "the saved node had no system prompt");
    assert.equal(c.strip_reasoning, undefined);
    assert.equal(c.include_history, false);
    assert.equal(c.prompt_template, "C {{a.output}}", "kept: this saved node has no prompt");
    assert.deepEqual(c.depends_on, ["a"]);
  });

  it("a saved prompt is fitted to where the node lands", () => {
    const critic = {
      name: "critic",
      model: { provider: "ollama" as const, name: "llama3" },
      prompt_template: "Critique:\n{{ draft.output }}\n\nQuestion: {{ question }}",
    };
    // added after one node: the one unknown reference points at that input
    let added = addNode(diamond(), { after: ["b"], preset: critic });
    let node = added.definition.nodes.at(-1)!;
    assert.equal(node.prompt_template, "Critique:\n{{ b.output }}\n\nQuestion: {{ question }}");
    assert.deepEqual(node.depends_on, ["b"]);

    // references to nodes this pipeline has become inputs
    added = addNode(diamond(), { preset: { ...critic, prompt_template: "{{ a.output }} {{ c.output }}" } });
    assert.deepEqual(added.definition.nodes.at(-1)!.depends_on, ["a", "c"]);

    // loop back-references (`is defined`) never become inputs
    const guarded = "{% if d is defined %}{{ d.output }}{% endif %}{{ a.output }}";
    added = addNode(diamond(), { preset: { ...critic, prompt_template: guarded } });
    assert.deepEqual(added.definition.nodes.at(-1)!.depends_on, ["a"]);

    // ambiguous: left alone for validation to point at
    added = addNode(diamond(), { after: ["b", "c"], preset: critic });
    node = added.definition.nodes.at(-1)!;
    assert.match(node.prompt_template, /draft\.output/);
    assert.deepEqual(node.depends_on, ["b", "c"]);

    assert.deepEqual([...templateNodeRefs(guarded).guarded], ["d"]);
  });

  it("a new pipeline can start from a saved node", () => {
    const model = { provider: "ollama" as const, name: "llama3", temperature: 0.2 };
    const blank = newDefinition("p", model);
    assert.deepEqual(blank.output_nodes, ["answer"]);
    assert.equal(blank.nodes[0]!.prompt_template, "{{ conversation }}");
    const saved = newDefinition("p", model, {
      name: "polite-answer",
      model: { provider: "ollama", name: "gemma3:12b" },
      system_prompt: "Be polite.",
      prompt_template: "{{ input }}",
    });
    assert.deepEqual(saved.output_nodes, ["polite_answer"]);
    assert.equal(saved.nodes[0]!.system_prompt, "Be polite.");
    assert.equal(saved.nodes[0]!.model!.name, "gemma3:12b");
  });
});

describe("pipeline defaults and history settings", () => {
  const withDefaults = (): PipelineDefinition => ({
    ...diamond(),
    defaults: { model: { provider: "ollama", name: "base", temperature: 0.6, options: { num_ctx: 4096, keep_alive: "10m" } } },
    history: { remember: ["b", "c"] },
  });

  it("new nodes inherit the default model instead of copying one", () => {
    const { definition } = addNode(withDefaults(), { id: "e" });
    assert.equal(definition.nodes.at(-1)!.model, undefined);
    const plain = addNode(diamond(), { id: "e" }).definition;
    assert.equal(plain.nodes.at(-1)!.model!.name, "llama3");
  });

  it("effectiveModel applies the server's inheritance rules", () => {
    let def = addNode(withDefaults(), { id: "e" }).definition;
    assert.deepEqual(effectiveModel(def, def.nodes.at(-1)!), {
      provider: "ollama", name: "base", temperature: 0.6, options: { num_ctx: 4096, keep_alive: "10m" },
    });
    // node d has its own model with num_ctx 4096 and no temperature
    def = updateNodeModel(def, "d", (m) => modelWithOption(m, "num_ctx", 8192));
    assert.deepEqual(effectiveModel(def, def.nodes.find((n) => n.id === "d")!)!.options, { num_ctx: 8192, keep_alive: "10m" });
    assert.equal(effectiveModel(def, def.nodes.find((n) => n.id === "d")!)!.temperature, 0.6);
  });

  it("a node can switch back to inheriting the default model", () => {
    const def = setNodeModel(withDefaults(), "a", undefined);
    assert.equal(def.nodes[0]!.model, undefined);
    assert.throws(() => setNodeModel(diamond(), "a", undefined), DraftError);
  });

  it("setPipelineSetting edits defaults, history and execution", () => {
    const base = modelWithIdentity(undefined, "ollama:gemma3:12b");
    let def = setPipelineSetting(diamond(), "defaults", "model", modelWithOption({ ...base, temperature: 0.3 }, "num_ctx", 2048));
    def = setPipelineSetting(def, "history", "max_chars", 5000);
    def = setPipelineSetting(def, "history", "summarize", { model: modelWithIdentity(undefined, "llama3.2:3b") });
    def = setPipelineSetting(def, "execution", "max_concurrency", 2);
    assert.deepEqual(def.defaults, { model: { provider: "ollama", name: "gemma3:12b", temperature: 0.3, options: { num_ctx: 2048 } } });
    assert.deepEqual(def.history, { max_chars: 5000, summarize: { model: { provider: "ollama", name: "llama3.2:3b" } } });
    assert.equal(def.execution!.max_concurrency, 2);
    def = setPipelineSetting(def, "history", "summarize", undefined);
    assert.deepEqual(def.history, { max_chars: 5000 });
    def = setPipelineSetting(def, "execution", "max_concurrency", undefined);
    assert.equal(def.execution, undefined, "an emptied section is dropped");
  });

  it("remembered nodes follow renames and removals", () => {
    assert.deepEqual(renameNode(withDefaults(), "b", "bee").history!.remember, ["bee", "c"]);
    assert.deepEqual(removeNode(withDefaults(), "c").history!.remember, ["b"]);
  });

});

describe("test cases", () => {
  it("adds, renames and removes cases, dropping an empty tests block", () => {
    let def = upsertTestCase(diamond(), { name: uniqueCaseName(diamond()), input: "2+2?", expect: [] });
    assert.deepEqual(def.tests, { cases: [{ name: "case 1", input: "2+2?" }] });
    assert.equal(uniqueCaseName(def), "case 2");
    def = upsertTestCase(def, { name: "math", input: "2+2?", expect: [makeExpectation("contains", "4")] }, "case 1");
    assert.deepEqual(def.tests!.cases, [{ name: "math", input: "2+2?", expect: [{ contains: "4" }] }]);
    def = upsertTestCase(def, { name: "other", input: "x" });
    assert.throws(() => upsertTestCase(def, { name: "math", input: "y" }, "other"), DraftError);
    assert.throws(() => upsertTestCase(def, { name: "  ", input: "y" }), DraftError);
    def = removeTestCase(removeTestCase(def, "math"), "other");
    assert.equal(def.tests, undefined);
  });

  it("sets and clears the judge model", () => {
    let def = setTestJudge(diamond(), modelWithIdentity(undefined, "ollama:llama3.2:3b"));
    assert.deepEqual(def.tests, { judge: { model: { provider: "ollama", name: "llama3.2:3b" } } });
    def = setTestJudge(def, undefined);
    assert.equal(def.tests, undefined);
  });

  it("reads an expectation's kind and value", () => {
    assert.deepEqual(expectationParts({ not_contains: "Berlin" }), { kind: "not_contains", value: "Berlin" });
    assert.deepEqual(expectationParts(makeExpectation("judge", "is polite")), { kind: "judge", value: "is polite" });
  });
});
