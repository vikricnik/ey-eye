import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { readOpenSections } from "../src/editor/Section";

describe("readOpenSections (which settings sections were left open)", () => {
  it("reads what was saved", () => {
    assert.deepEqual(readOpenSections('{"prompts":true,"routing":false}'), { prompts: true, routing: false });
  });

  it("starts empty when nothing was saved, or it can't be read", () => {
    assert.deepEqual(readOpenSections(null), {});
    assert.deepEqual(readOpenSections("not json"), {});
    assert.deepEqual(readOpenSections("[1,2]"), {});
  });

  it("keeps only true/false entries", () => {
    assert.deepEqual(readOpenSections('{"model":true,"odd":"yes","n":1}'), { model: true });
  });
});
