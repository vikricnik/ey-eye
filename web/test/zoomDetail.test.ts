import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { COMPACT_BELOW, MAX_TEXT_SCALE, compactTextScale, fitOptions, isCompact } from "../src/editor/zoomDetail";

describe("isCompact", () => {
  it("switches cards to their compact form once zoomed out below the threshold", () => {
    assert.equal(isCompact(1, 1), false);
    assert.equal(isCompact(COMPACT_BELOW, 1), false);
    assert.equal(isCompact(COMPACT_BELOW - 0.01, 1), true);
  });

  it("follows the display text size: larger text goes compact sooner", () => {
    assert.equal(isCompact(1, 1.5), true);
    assert.equal(isCompact(0.8, 0.875), false);
  });
});

describe("compactTextScale", () => {
  it("cancels the zoom, so compact text reads at the display text size", () => {
    assert.equal(compactTextScale(0.5, 1), 2);
    assert.equal(compactTextScale(0.75, 1.5), 2);
  });

  it("never shrinks text, and stops scaling at MAX_TEXT_SCALE", () => {
    assert.equal(compactTextScale(1.2, 1), 1);
    assert.equal(compactTextScale(0.2, 1), MAX_TEXT_SCALE);
  });
});

describe("fitOptions", () => {
  it("fits between the zoom where compact text is at its largest and the text size", () => {
    const fit = fitOptions(1);
    assert.equal(fit.maxZoom, 1);
    assert.equal(fit.minZoom, 1 / MAX_TEXT_SCALE);
    assert.equal(compactTextScale(fit.minZoom, 1), MAX_TEXT_SCALE);
  });
});
