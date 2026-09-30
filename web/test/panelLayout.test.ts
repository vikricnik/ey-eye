import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DEFAULT_LAYOUT,
  HIDE_BELOW,
  MIN_SECTION_HEIGHT,
  clampWidth,
  dragWidth,
  isStacked,
  openAbove,
  openSection,
  openShares,
  readPanelLayout,
  resizeSplit,
  shownHidden,
  toggleSection,
} from "../src/ui/panelLayout";

describe("readPanelLayout", () => {
  it("uses the defaults when nothing (readable) was saved", () => {
    for (const raw of [null, "{oops", "null", "[]", "5"]) assert.deepEqual(readPanelLayout(raw), DEFAULT_LAYOUT, String(raw));
  });

  it("ignores the old column widths", () => {
    assert.deepEqual(readPanelLayout('{"settings":380,"run":420}'), DEFAULT_LAYOUT);
  });

  it("reads what was saved, field by field", () => {
    const saved = {
      width: 520,
      hidden: true,
      open: { node: false, chat: true, pipeline: true, tests: false, add: false },
      weights: { node: 1, chat: 2, pipeline: 0.5, tests: 1, add: 0.8 },
    };
    assert.deepEqual(readPanelLayout(JSON.stringify(saved)), saved);
  });

  it("falls back per field for what's missing or unreadable", () => {
    const layout = readPanelLayout(
      '{"width":"wide","hidden":1,"open":{"tests":true,"chat":"yes","nope":true},"weights":{"chat":-1,"node":3}}'
    );
    assert.equal(layout.width, DEFAULT_LAYOUT.width);
    assert.equal(layout.hidden, false);
    assert.deepEqual(layout.open, { ...DEFAULT_LAYOUT.open, tests: true });
    assert.deepEqual(layout.weights, { ...DEFAULT_LAYOUT.weights, node: 3 });
  });

  it("keeps a layout with every section folded", () => {
    const allFolded = { node: false, chat: false, pipeline: false, tests: false, add: false };
    assert.deepEqual(readPanelLayout(JSON.stringify({ open: allFolded })).open, allFolded);
  });
});

describe("clampWidth", () => {
  it("keeps a width between 340px and 760px — or 60% of a smaller window", () => {
    assert.equal(clampWidth(440, 1440), 440);
    assert.equal(clampWidth(100, 1440), 340);
    assert.equal(clampWidth(2000, 1440), 760);
    assert.equal(clampWidth(760, 1100), 660, "a monitor's width, shown on a laptop");
  });

  it("never goes below 340px, even in a small window", () => {
    assert.equal(clampWidth(440, 500), 340);
  });
});

describe("dragWidth", () => {
  it("resizes, within the limits", () => {
    assert.equal(dragWidth(DEFAULT_LAYOUT, 600, 1440).width, 600);
    assert.equal(dragWidth(DEFAULT_LAYOUT, 5000, 1440).width, 760);
  });

  it("hides the panel when dragged below 240px, keeping the width to come back to", () => {
    const hidden = dragWidth({ ...DEFAULT_LAYOUT, width: 520 }, HIDE_BELOW - 1, 1440);
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.width, 520);
  });

  it("shows it again when dragged back out", () => {
    assert.equal(dragWidth({ ...DEFAULT_LAYOUT, hidden: true }, 400, 1440).hidden, false);
  });
});

describe("toggleSection / openSection", () => {
  it("folds an open section and opens a folded one", () => {
    assert.equal(toggleSection(DEFAULT_LAYOUT, "chat").open.chat, false);
    assert.equal(toggleSection(DEFAULT_LAYOUT, "tests").open.tests, true);
  });

  it("opens a section, leaving an open one as it is", () => {
    assert.equal(openSection(DEFAULT_LAYOUT, "tests").open.tests, true);
    assert.equal(openSection(DEFAULT_LAYOUT, "node"), DEFAULT_LAYOUT);
  });
});

describe("openAbove", () => {
  it("finds the nearest open section above — the one a header drag re-splits with", () => {
    const layout = { ...DEFAULT_LAYOUT, open: { node: true, chat: false, pipeline: true, tests: true, add: false } };
    assert.equal(openAbove(layout, "pipeline"), "node");
    assert.equal(openAbove(layout, "tests"), "pipeline");
    assert.equal(openAbove(layout, "node"), null);
  });
});

describe("resizeSplit", () => {
  const heights = { above: 300, below: 300 };
  const layout = { ...DEFAULT_LAYOUT, weights: { ...DEFAULT_LAYOUT.weights, node: 1, chat: 1 } };

  it("moves the boundary, keeping the pair's combined weight", () => {
    const next = resizeSplit(layout, "node", "chat", heights, 60);
    assert.ok(Math.abs(next.weights.node - 1.2) < 1e-9);
    assert.ok(Math.abs(next.weights.chat - 0.8) < 1e-9);
    assert.equal(next.weights.pipeline, layout.weights.pipeline);
  });

  it("stops at 76px for either section", () => {
    const up = resizeSplit(layout, "node", "chat", heights, -1000);
    assert.ok(Math.abs(up.weights.node - (2 * MIN_SECTION_HEIGHT) / 600) < 1e-9);
    const down = resizeSplit(layout, "node", "chat", heights, 1000);
    assert.ok(Math.abs(down.weights.chat - (2 * MIN_SECTION_HEIGHT) / 600) < 1e-9);
  });

  it("leaves two sections too short to split as they are", () => {
    assert.equal(resizeSplit(layout, "node", "chat", { above: 70, below: 70 }, 20), layout);
  });
});

describe("openShares", () => {
  const sum = (shares: Record<string, number>) => Object.values(shares).reduce((a, b) => a + b, 0);

  it("gives the open sections all of the height, whatever their weights add up to", () => {
    // Two sections dragged to their minimum: weights well under 1 in total,
    // which as flex-grow values would leave the rest of the panel empty.
    const layout = {
      ...DEFAULT_LAYOUT,
      open: { node: true, chat: true, pipeline: false, tests: false, add: false },
      weights: { ...DEFAULT_LAYOUT.weights, node: 0.44, chat: 0.4 },
    };
    const shares = openShares(layout);
    assert.ok(Math.abs(sum(shares) - 1) < 1e-9);
    assert.ok(Math.abs(shares.node / shares.chat - 0.44 / 0.4) < 1e-9, "keeps the split");
    assert.equal(shares.pipeline, 0);
  });

  it("gives a section open on its own the whole height", () => {
    const layout = {
      ...DEFAULT_LAYOUT,
      open: { node: false, chat: false, pipeline: false, tests: true, add: false },
      weights: { ...DEFAULT_LAYOUT.weights, tests: 0.3 },
    };
    assert.equal(openShares(layout).tests, 1);
  });

  it("is all zeros with every section folded", () => {
    const layout = { ...DEFAULT_LAYOUT, open: { node: false, chat: false, pipeline: false, tests: false, add: false } };
    assert.equal(sum(openShares(layout)), 0);
  });
});

describe("isStacked / shownHidden", () => {
  it("stacks at 960px and below, like the CSS", () => {
    assert.equal(isStacked(961), false);
    assert.equal(isStacked(960), true);
  });

  it("never hides a stacked panel, but keeps the saved choice for a wide window", () => {
    const layout = { ...DEFAULT_LAYOUT, hidden: true };
    assert.equal(shownHidden(layout, 800), false);
    assert.equal(shownHidden(layout, 1440), true);
    assert.equal(layout.hidden, true);
  });
});
