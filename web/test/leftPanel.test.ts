import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { LeftPanel } from "../src/ui/LeftPanel";
import type { PanelSectionSpec } from "../src/ui/LeftPanel";
import { DEFAULT_LAYOUT } from "../src/ui/panelLayout";
import type { PanelLayoutApi } from "../src/ui/usePanelLayout";

const noop = () => {};

function render(hidden: boolean): string {
  const panel: PanelLayoutApi = {
    layout: { ...DEFAULT_LAYOUT, hidden },
    width: 440,
    stacked: false,
    hidden,
    style: {},
    toggleSection: noop,
    openSection: noop,
    resizeSplit: noop,
    dragWidth: noop,
    resetWidth: noop,
    setHidden: noop,
  };
  const sections: PanelSectionSpec[] = [
    { id: "node", title: "Node", summary: "nothing selected", icon: null, content: createElement("p", { id: "node-body" }) },
    { id: "chat", title: "Chat", summary: "no runs", icon: null, content: createElement("p", { id: "chat-body" }) },
  ];
  return renderToStaticMarkup(
    createElement(LeftPanel, {
      panel,
      header: createElement("p", { id: "head-probe" }),
      notices: createElement("p", { id: "notice-probe" }),
      sections,
      placeholder: null,
      dock: createElement("textarea", { id: "dock-probe" }),
      state: { tone: "ok", label: "saved" },
    })
  );
}

describe("LeftPanel hidden", () => {
  it("keeps the message box and the sections mounted, so a draft and their state survive hide and show", () => {
    const html = render(true);
    assert.match(html, /class="rail"/);
    assert.match(html, /id="dock-probe"/);
    assert.match(html, /id="chat-body"/);
    assert.match(html, /id="head-probe"/);
  });

  it("hides the header, the sections and the message box, but not the notices", () => {
    const html = render(true);
    assert.match(html, /<div class="dock" hidden="">/);
    assert.match(html, /<div class="psections" hidden="">/);
    assert.match(html, /<header class="panel-head" hidden="">/);
    assert.match(html, /<div class="panel-notices"><p id="notice-probe">/);
  });

  it("shows no rail and hides nothing when shown", () => {
    const html = render(false);
    assert.doesNotMatch(html, /class="rail"/);
    assert.doesNotMatch(html, /hidden=""/);
  });
});
