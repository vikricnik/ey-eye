import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { DraftError } from "@llm-pipeline/client";
import type { PipelineDefinition } from "@llm-pipeline/client";
import { coerceFieldValue, resolveNodeFieldPath, setNodeFieldByPath, setPipelineSettingByPath } from "../src/fieldPaths.js";

function diamond(): PipelineDefinition {
  return {
    name: "d",
    nodes: [
      { id: "a", depends_on: [], model: { provider: "ollama", name: "llama3" }, prompt_template: "{{ input }}" },
      { id: "b", depends_on: ["a"], model: { provider: "ollama", name: "llama3" }, prompt_template: "B {{ a.output }}" },
      {
        id: "d",
        depends_on: ["b"],
        model: { provider: "ollama", name: "llama3", options: { num_ctx: 4096 } },
        prompt_template: "{{ b.output }}",
      },
    ],
    output_nodes: ["d"],
  };
}

describe("/set <node>.<field>", () => {
  it("sets nested fields through aliases and clears empty containers", () => {
    let def = setNodeFieldByPath(diamond(), "a", "temperature", 0.7);
    def = setNodeFieldByPath(def, "a", "options.num_ctx", 8192);
    def = setNodeFieldByPath(def, "a", "system", "Be terse.");
    const a = def.nodes[0]!;
    assert.equal(a.model!.temperature, 0.7);
    assert.deepEqual(a.model!.options, { num_ctx: 8192 });
    assert.equal(a.system_prompt, "Be terse.");

    def = setNodeFieldByPath(def, "a", "options.num_ctx", undefined);
    assert.equal(def.nodes[0]!.model!.options, undefined, "empty options object removed");
    assert.deepEqual(resolveNodeFieldPath("options.num_ctx"), ["model", "options", "num_ctx"]);
  });

  it("takes a 'provider:model' identity for the model, and 'default' to inherit", () => {
    const def = setNodeFieldByPath(diamond(), "d", "model", "openai:gpt-4o");
    assert.deepEqual(def.nodes[2]!.model, { provider: "openai", name: "gpt-4o" });
    const withDefault: PipelineDefinition = { ...diamond(), defaults: { model: { provider: "ollama", name: "base" } } };
    assert.equal(setNodeFieldByPath(withDefault, "a", "model", "default").nodes[0]!.model, undefined);
    assert.throws(() => setNodeFieldByPath(diamond(), "a", "model", "default"), DraftError);
  });

  it("'id' renames everywhere", () => {
    const def = setNodeFieldByPath(diamond(), "b", "id", "bee");
    assert.deepEqual(def.nodes.find((n) => n.id === "d")!.depends_on, ["bee"]);
  });

  it("refuses a field nodes don't have, instead of writing it", () => {
    assert.throws(() => setNodeFieldByPath(diamond(), "a", "temprature", 0.3), DraftError);
  });
});

describe("/pset <setting>", () => {
  it("edits defaults, history and execution by path", () => {
    let def = setPipelineSettingByPath(diamond(), "defaults.model", "ollama:gemma3:12b");
    def = setPipelineSettingByPath(def, "defaults.temperature", 0.3);
    def = setPipelineSettingByPath(def, "defaults.options.num_ctx", 2048);
    def = setPipelineSettingByPath(def, "history.max_chars", 5000);
    def = setPipelineSettingByPath(def, "history.summarize.model", "llama3.2:3b");
    def = setPipelineSettingByPath(def, "execution.max_concurrency", 2);
    assert.deepEqual(def.defaults, { model: { provider: "ollama", name: "gemma3:12b", temperature: 0.3, options: { num_ctx: 2048 } } });
    assert.deepEqual(def.history, { max_chars: 5000, summarize: { model: { provider: "ollama", name: "llama3.2:3b" } } });
    assert.equal(def.execution!.max_concurrency, 2);
    def = setPipelineSettingByPath(def, "history.summarize.model", "unset");
    assert.deepEqual(def.history, { max_chars: 5000 });
    def = setPipelineSettingByPath(def, "description", "about");
    assert.equal(def.description, "about");
  });

  it("refuses what isn't a pipeline setting, or a default-model setting with no default model", () => {
    assert.throws(() => setPipelineSettingByPath(diamond(), "nodes", []), DraftError);
    assert.throws(() => setPipelineSettingByPath(diamond(), "defaults.temperature", 0.3), DraftError);
  });
});

describe("coerceFieldValue", () => {
  it("parses numbers, lists and unset", () => {
    assert.equal(coerceFieldValue("temperature", "0.3"), 0.3);
    assert.equal(coerceFieldValue("options.num_ctx", "8192"), 8192);
    assert.deepEqual(coerceFieldValue("deps", "a, b"), ["a", "b"]);
    assert.deepEqual(coerceFieldValue("options.stop", "###,END"), ["###", "END"]);
    assert.equal(coerceFieldValue("options.keep_alive", "5m"), "5m");
    assert.equal(coerceFieldValue("options.keep_alive", "0"), 0);
    assert.equal(coerceFieldValue("system", "unset"), undefined);
    assert.equal(coerceFieldValue("system", "Be kind, always."), "Be kind, always.");
    assert.throws(() => coerceFieldValue("temperature", "hot"), DraftError);
  });

  it("coerces on/off and list settings", () => {
    assert.equal(coerceFieldValue("history", "off"), false);
    assert.equal(coerceFieldValue("reasoning", "yes"), true);
    assert.equal(coerceFieldValue("strip_reasoning", "inherit"), undefined);
    assert.deepEqual(coerceFieldValue("history.remember", "a, b"), ["a", "b"]);
    assert.equal(coerceFieldValue("execution.max_concurrency", "2"), 2);
    assert.throws(() => coerceFieldValue("include_history", "maybe"), DraftError);
  });
});
