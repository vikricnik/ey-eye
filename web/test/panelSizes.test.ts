import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { DEFAULT_PANEL_SIZES, clampPanelSizes } from "../src/ui/Splitter";

describe("clampPanelSizes", () => {
  it("keeps the panel usable and leaves the canvas room", () => {
    assert.deepEqual(clampPanelSizes(DEFAULT_PANEL_SIZES, 1400), DEFAULT_PANEL_SIZES);
    assert.equal(clampPanelSizes({ panel: 100 }, 1400).panel, 320, "not narrower than its content");
    assert.equal(clampPanelSizes({ panel: 1300 }, 1400).panel, 1120, "the canvas keeps 280px");
    assert.equal(clampPanelSizes({ panel: 500 }, 500).panel, 320, "a tiny window still gets a usable panel");
  });
});
