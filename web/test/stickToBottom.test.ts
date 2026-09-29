import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { isNearBottom } from "../src/run/stickToBottom";

describe("isNearBottom", () => {
  it("counts the very end, and anything within 40px of it", () => {
    assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), true);
    assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 561, clientHeight: 400 }), true);
  });

  it("doesn't count a box scrolled up to read something earlier", () => {
    assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 560, clientHeight: 400 }), false);
    assert.equal(isNearBottom({ scrollHeight: 1000, scrollTop: 0, clientHeight: 400 }), false);
  });

  it("counts content that fits without scrolling", () => {
    assert.equal(isNearBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 400 }), true);
  });
});
