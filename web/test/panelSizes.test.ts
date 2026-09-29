import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { DEFAULT_PANEL_SIZES, clampPanelSizes, readPanelSizes } from "../src/ui/Splitter";

describe("clampPanelSizes", () => {
  it("keeps the panel usable and leaves the canvas room", () => {
    assert.deepEqual(clampPanelSizes(DEFAULT_PANEL_SIZES, 1400), DEFAULT_PANEL_SIZES);
    assert.equal(clampPanelSizes({ panel: 100 }, 1400).panel, 320, "not narrower than its content");
    assert.equal(clampPanelSizes({ panel: 1300 }, 1400).panel, 1120, "the canvas keeps 280px");
    assert.equal(clampPanelSizes({ panel: 500 }, 500).panel, 320, "a tiny window still gets a usable panel");
  });
});

describe("readPanelSizes", () => {
  it("reads the width someone chose as it was saved — the window fits it later, without overwriting it", () => {
    assert.deepEqual(readPanelSizes('{"panel":600}'), { panel: 600 });
    assert.equal(clampPanelSizes(readPanelSizes('{"panel":600}'), 700).panel, 420, "shown narrower in a small window");
  });

  it("falls back to the default when nothing (readable) was saved", () => {
    assert.deepEqual(readPanelSizes(null), DEFAULT_PANEL_SIZES);
    assert.deepEqual(readPanelSizes("{oops"), DEFAULT_PANEL_SIZES);
    assert.deepEqual(readPanelSizes('{"panel":"wide"}'), DEFAULT_PANEL_SIZES);
  });
});
