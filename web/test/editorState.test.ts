import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { PipelineDefinition } from "@llm-pipeline/client";
import { docReducer } from "../src/editor/editorState";
import type { EditorDoc } from "../src/editor/editorState";

const base: PipelineDefinition = {
  name: "p",
  nodes: [{ id: "a", model: { provider: "ollama", model: "m" }, prompt_template: "{{ input }}" }],
  output_node: "a",
};
const withPrompt = (prompt: string): PipelineDefinition => ({
  ...base,
  nodes: [{ ...base.nodes[0]!, prompt_template: prompt }],
});

function loaded(saved = true): EditorDoc {
  return docReducer(null, { type: "load", definition: base, baseRevision: saved ? "r1" : null, saved })!;
}

describe("docReducer", () => {
  it("tracks unsaved changes against what's saved", () => {
    let doc = loaded();
    assert.equal(doc.dirty, false);
    doc = docReducer(doc, { type: "edit", definition: withPrompt("x"), at: 0 })!;
    assert.equal(doc.dirty, true);
    doc = docReducer(doc, { type: "undo" })!;
    assert.equal(doc.dirty, false, "undoing back to the saved state clears it");
    assert.equal(loaded(false).dirty, true, "a never-saved draft is unsaved");
  });

  it("merges quick edits to one field into a single undo step", () => {
    let doc = loaded();
    doc = docReducer(doc, { type: "edit", definition: withPrompt("a"), coalesce: "prompt", at: 0 })!;
    doc = docReducer(doc, { type: "edit", definition: withPrompt("ab"), coalesce: "prompt", at: 300 })!;
    doc = docReducer(doc, { type: "edit", definition: withPrompt("abc"), coalesce: "prompt", at: 2000 })!;
    assert.equal(doc.past.length, 2, "the pause started a new step");
    doc = docReducer(doc, { type: "undo" })!;
    assert.equal(doc.definition.nodes[0]!.prompt_template, "ab");
    doc = docReducer(doc, { type: "redo" })!;
    assert.equal(doc.definition.nodes[0]!.prompt_template, "abc");
    assert.equal(docReducer(doc, { type: "redo" }), doc, "nothing to redo: unchanged");
  });

  it("keeps the undo history across a save", () => {
    let doc = docReducer(loaded(), { type: "edit", definition: withPrompt("x"), at: 0 })!;
    doc = docReducer(doc, { type: "saved", definition: doc.definition, revision: "r2" })!;
    assert.equal(doc.dirty, false);
    assert.equal(doc.baseRevision, "r2");
    doc = docReducer(doc, { type: "undo" })!;
    assert.equal(doc.dirty, true, "undoing past a save differs from the file again");
  });
});
