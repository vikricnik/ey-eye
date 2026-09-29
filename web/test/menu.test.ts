import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { menuIndexFor } from "../src/ui/Menu";

describe("menuIndexFor (menu keyboard navigation)", () => {
  it("moves with the arrow keys, wrapping at either end", () => {
    assert.equal(menuIndexFor("ArrowDown", 0, 5), 1);
    assert.equal(menuIndexFor("ArrowDown", 4, 5), 0);
    assert.equal(menuIndexFor("ArrowUp", 0, 5), 4);
    assert.equal(menuIndexFor("ArrowUp", 3, 5), 2);
  });

  it("jumps to the first and last item with Home and End", () => {
    assert.equal(menuIndexFor("Home", 3, 5), 0);
    assert.equal(menuIndexFor("End", 1, 5), 4);
  });

  it("ignores every other key", () => {
    assert.equal(menuIndexFor("Enter", 2, 5), null);
    assert.equal(menuIndexFor("a", 2, 5), null);
  });
});
