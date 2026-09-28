import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { renamedCommandHint } from "../src/renamedCommands.js";

describe("renamed commands", () => {
  it("say where they went instead of becoming unknown", () => {
    assert.match(renamedCommandHint("/pipelines")!, /\/pipeline list/);
    assert.match(renamedCommandHint("/delete my-pipe")!, /\/pipeline rm <name>/);
    assert.match(renamedCommandHint("/tests")!, /\/test\b/);
    assert.match(renamedCommandHint("/pset history.max_chars 4000")!, /\/settings set/);
    assert.match(renamedCommandHint("/library save critic")!, /\/preset/);
    assert.match(renamedCommandHint("/nodes")!, /\/node\b/);
  });

  it("leaves every other command alone", () => {
    for (const line of ["/pipeline", "/test run", "/preset", "/settings", "/node rm a", "/set a.temperature 1"]) {
      assert.equal(renamedCommandHint(line), undefined, line);
    }
  });
});
