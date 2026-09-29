import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { DEFAULT_PANEL_SIZES, clampPanelSizes, readPanelSizes, settingsPlacement } from "../src/ui/panelSizes";

describe("clampPanelSizes", () => {
  it("keeps the defaults in a laptop-sized window", () => {
    assert.deepEqual(clampPanelSizes(DEFAULT_PANEL_SIZES, 1366), DEFAULT_PANEL_SIZES);
  });

  it("keeps both columns usable", () => {
    assert.deepEqual(clampPanelSizes({ settings: 100, run: 100 }, 1400), { settings: 320, run: 320 });
  });

  it("leaves the canvas 280px beside the run panel, then beside both columns", () => {
    assert.equal(clampPanelSizes({ settings: 380, run: 1300 }, 1400).run, 1120);
    assert.equal(clampPanelSizes({ settings: 900, run: 420 }, 1400).settings, 700);
  });

  it("gives a tiny window usable columns anyway", () => {
    assert.deepEqual(clampPanelSizes(DEFAULT_PANEL_SIZES, 500), { settings: 320, run: 320 });
  });
});

describe("readPanelSizes", () => {
  it("reads the widths someone chose as they were saved — the window fits them later", () => {
    assert.deepEqual(readPanelSizes('{"settings":500,"run":600}'), { settings: 500, run: 600 });
    assert.equal(clampPanelSizes(readPanelSizes('{"settings":500,"run":600}'), 1000).run, 600);
  });

  it("fills in a width that's missing or unreadable with its default", () => {
    assert.deepEqual(readPanelSizes('{"run":600}'), { settings: 380, run: 600 });
    assert.deepEqual(readPanelSizes('{"settings":"wide","run":600}'), { settings: 380, run: 600 });
  });

  it("falls back to the defaults when nothing (readable) was saved — including v2's single width", () => {
    assert.deepEqual(readPanelSizes(null), DEFAULT_PANEL_SIZES);
    assert.deepEqual(readPanelSizes("{oops"), DEFAULT_PANEL_SIZES);
    assert.deepEqual(readPanelSizes("null"), DEFAULT_PANEL_SIZES);
    assert.deepEqual(readPanelSizes('{"panel":600}'), DEFAULT_PANEL_SIZES);
  });
});

describe("settingsPlacement", () => {
  it("docks the settings column while the canvas keeps 480px", () => {
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 1920), "docked");
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 1366), "docked");
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 1280), "docked", "exactly 480px left");
  });

  it("floats it over the canvas when docking would leave less", () => {
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 1279), "floating");
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 1100), "floating");
    assert.equal(settingsPlacement({ settings: 600, run: 600 }, 1600), "floating");
  });

  it("stacks everything in a narrow window, like the CSS does", () => {
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 961), "floating");
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 960), "stacked");
    assert.equal(settingsPlacement(DEFAULT_PANEL_SIZES, 375), "stacked");
  });
});
