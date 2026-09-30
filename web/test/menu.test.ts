import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { menuIndexFor, menuShift } from "../src/ui/Menu";

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

describe("menuShift (keeping a menu inside the window)", () => {
  const MENU = 272; // 17rem at the default text size

  it("leaves a menu that fits where it opens", () => {
    assert.equal(menuShift({ left: 100, right: 170 }, MENU, 1024, "start"), 0);
    assert.equal(menuShift({ left: 893, right: 962 }, MENU, 1024, "end"), 0);
  });

  it("moves a menu that would run off the right edge back in, 8px from it", () => {
    // File in the top bar at 1024px, opening rightwards: 893 + 272 = 1165.
    assert.equal(menuShift({ left: 893, right: 962 }, MENU, 1024, "start"), 744 - 893);
  });

  it("moves a menu that would run off the left edge back in, 8px from it", () => {
    // File in the wrapped toolbar on a 375px phone, opening leftwards: 224 - 272 = -48.
    assert.equal(menuShift({ left: 154, right: 224 }, MENU, 375, "end"), 8 - -48);
  });

  it("fixes the phone case opening rightwards too", () => {
    assert.equal(menuShift({ left: 154, right: 224 }, MENU, 375, "start"), 95 - 154);
  });

  it("keeps the left edge visible when the menu is wider than the window", () => {
    assert.equal(menuShift({ left: 10, right: 80 }, 400, 375, "start"), 8 - 10);
  });
});
