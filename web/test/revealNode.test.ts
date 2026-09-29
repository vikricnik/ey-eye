import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { needsReveal, revealCenter } from "../src/editor/revealNode";

// Its center is at (200, 140) in flow coordinates.
const node = { x: 100, y: 100, width: 200, height: 80 };
const screen = { width: 800, height: 600 };

describe("needsReveal", () => {
  it("leaves a node alone whose center can be seen", () => {
    assert.equal(needsReveal(node, { x: 0, y: 0, zoom: 1 }, screen), false);
  });

  it("reveals a node the narrower canvas pushed off its right edge", () => {
    assert.equal(needsReveal(node, { x: 0, y: 0, zoom: 1 }, { width: 150, height: 600 }), true);
  });

  it("counts a node under the floating settings column as hidden", () => {
    // 800px canvas, 380px of it covered: its center, at 500px, is under the column.
    assert.equal(needsReveal(node, { x: 300, y: 0, zoom: 1 }, { width: 800 - 380, height: 600 }), true);
  });

  it("applies the pan and zoom", () => {
    assert.equal(needsReveal(node, { x: -500, y: 0, zoom: 2 }, screen), true, "center at -100px");
    assert.equal(needsReveal(node, { x: -300, y: 0, zoom: 2 }, screen), false, "center at 100px");
    assert.equal(needsReveal(node, { x: 0, y: -200, zoom: 1 }, screen), true, "center above the top");
  });
});

describe("revealCenter", () => {
  it("centers the node in the canvas when nothing covers it", () => {
    assert.deepEqual(revealCenter(node, 1, 0), { x: 200, y: 140 });
  });

  it("shifts it into the middle of the uncovered part", () => {
    assert.deepEqual(revealCenter(node, 1, 380), { x: 390, y: 140 });
    assert.deepEqual(revealCenter(node, 2, 380), { x: 295, y: 140 });
  });
});
