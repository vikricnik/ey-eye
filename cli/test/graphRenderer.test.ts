import { strict as assert } from "node:assert";
import { afterEach, describe, it } from "node:test";

import { buildGraphModel, createGraphViewState } from "@llm-pipeline/client";
import type { PipelineDetail } from "@llm-pipeline/client";
import { renderGraphText } from "../src/graphRenderer.js";

// eslint-disable-next-line no-control-regex
const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;

const detail: PipelineDetail = {
  name: "p",
  description: "",
  output_node_candidates: ["summarize_everything"],
  nodes: [
    { id: "a", type: "llm_call", depends_on: [], model: "ollama:llama3.2:3b" },
    { id: "b", type: "llm_call", depends_on: ["a"], model: "ollama:qwen3-coder:30b" },
    { id: "summarize_everything", type: "llm_call", depends_on: ["a", "b"], model: "ollama:llama3" },
  ],
  branches: [],
  loops: [],
};

/** Every line of every level box, grouped per box. */
function boxes(lines: string[]): string[][] {
  const result: string[][] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
    if (plain.startsWith("┌")) current = [];
    if (current) current.push(line);
    if (plain.startsWith("└") && current) {
      result.push(current);
      current = null;
    }
  }
  return result;
}

function setColumns(columns: number | undefined): void {
  Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
}

describe("renderGraphText box borders", () => {
  afterEach(() => setColumns(undefined));

  for (const [label, columns] of [
    ["at natural width", 200],
    ["when capped by a narrow terminal", 24],
  ] as const) {
    it(`every row of a box is exactly as wide as its border, ${label}`, () => {
      setColumns(columns);
      const graph = buildGraphModel(detail);
      for (const state of [undefined, createGraphViewState(graph, { running: true })]) {
        const found = boxes(renderGraphText(graph, state));
        assert.equal(found.length, 3);
        for (const box of found) {
          const widths = box.map(visible);
          assert.ok(widths.every((w) => w === widths[0]), `uneven box: ${JSON.stringify(widths)}`);
        }
      }
    });
  }
});

describe("multi-target branch routes", () => {
  const routed: PipelineDetail = {
    name: "r",
    description: "",
    output_node_candidates: ["tech", "gen"],
    nodes: ["cls", "tech", "sec", "gen"].map((id) => ({ id, type: "llm_call", depends_on: [], model: "ollama:m" })),
    branches: [
      {
        id: "br",
        from: "cls",
        routes: [
          { to: ["tech", "sec"], when: "'T' in output", default: false },
          { to: "gen", when: null, default: true },
        ],
      },
    ],
    loops: [],
  };

  it("marks every target of the taken route as taken", () => {
    const state = createGraphViewState(buildGraphModel(routed));
    state.branchOutcomes["br"] = { branchId: "br", takenTargets: ["tech", "sec"] };
    const plain = renderGraphText(buildGraphModel(routed), state).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));

    assert.ok(plain.some((l) => l.includes("cls ⇢ tech ✓ taken")));
    assert.ok(plain.some((l) => l.includes("cls ⇢ sec ✓ taken")));
    assert.ok(plain.some((l) => l.includes("cls ⇢ gen (not taken)")));
  });
});
