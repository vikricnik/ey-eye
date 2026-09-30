import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { canvasHint } from "../src/editor/canvasHint";

describe("canvasHint", () => {
  it("suggests adding nodes to a pipeline of one", () => {
    assert.match(canvasHint({ nodes: 1, edges: 0, editable: true }) ?? "", /Add node section/);
  });

  it("explains connecting nodes while none are connected", () => {
    assert.match(canvasHint({ nodes: 3, edges: 0, editable: true }) ?? "", /bottom dot .* top dot/);
  });

  it("stays out of the way once nodes are connected, or when editing is off", () => {
    assert.equal(canvasHint({ nodes: 3, edges: 2, editable: true }), null);
    assert.equal(canvasHint({ nodes: 3, edges: 0, editable: false }), null);
    assert.equal(canvasHint({ nodes: 0, edges: 0, editable: true }), null);
  });
});
