import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Keeps style.css readable (UX-002 in UX_REVIEW.md): no text below 11px,
// and text colors that meet WCAG AA contrast (4.5:1) in both themes.

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Every rule as [selector, declarations] — innermost blocks, so rules
 * inside @media are included. */
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!] as const);

function customProperties(selector: string): Record<string, string> {
  const block = rules.find(([s]) => s === selector)?.[1] ?? "";
  return Object.fromEntries([...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

const dark = customProperties(":root");
const themes = { dark, light: { ...dark, ...customProperties(':root[data-theme="light"]') } };

const MIN_TEXT_PX = 11;
const rootPx = (value: string) => Number.parseFloat(value) * (value.endsWith("rem") ? 16 : 1);

describe("text size", () => {
  it("defines a type scale whose smallest step is 11px", () => {
    const steps = Object.entries(dark).filter(([name]) => name.startsWith("--fs-"));
    assert.ok(steps.length > 0, "no --fs-* tokens");
    for (const [name, value] of steps) assert.ok(rootPx(value) >= MIN_TEXT_PX, `${name}: ${value}`);
  });

  it("sets every font size from the scale, or in px no smaller than 11 on the canvas", () => {
    for (const [selector, declarations] of rules) {
      for (const [, value] of declarations.matchAll(/font-size\s*:\s*([^;]+);?/g)) {
        const v = value!.trim();
        if (/^var\(--fs-(xs|sm|md|lg|xl)\)$/.test(v) || v === "inherit") continue;
        // Canvas text is in flow coordinates (px), optionally scaled up by the zoom.
        const px = /^(?:calc\()?(\d+(?:\.\d+)?)px(?: \* var\(--node-text-scale, 1\)\))?$/.exec(v);
        assert.ok(px && Number(px[1]) >= MIN_TEXT_PX, `${selector} { font-size: ${v} }`);
      }
    }
  });
});

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `color` at `alpha` over `surface` — what color-mix(in srgb, color N%, transparent) shows. */
function tint(color: string, alpha: number, surface: string): string {
  const mixed = [0, 1, 2].map((i) => {
    const c = (hex: string) => Number.parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
    return Math.round(c(color) * alpha + c(surface) * (1 - alpha));
  });
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

describe("text contrast (WCAG AA, 4.5:1)", () => {
  const surfaces = ["--bg", "--panel", "--panel-raised"];
  const texts = ["--text", "--text-dim", "--accent", "--valid", "--invalid", "--warn", "--running"];
  const status = ["--accent", "--valid", "--invalid", "--warn", "--running"];

  for (const [name, colors] of Object.entries(themes)) {
    it(`${name}: every text color reads on every surface`, () => {
      for (const text of texts) {
        for (const surface of surfaces) {
          const ratio = contrast(colors[text]!, colors[surface]!);
          assert.ok(ratio >= 4.5, `${text} on ${surface}: ${ratio.toFixed(2)}`);
        }
      }
    });

    it(`${name}: status colors read on their own tints (badges, notices, results — up to 15%)`, () => {
      for (const color of status) {
        for (const surface of surfaces) {
          const ratio = contrast(colors[color]!, tint(colors[color]!, 0.15, colors[surface]!));
          assert.ok(ratio >= 4.5, `${color} on its 15% tint over ${surface}: ${ratio.toFixed(2)}`);
        }
      }
    });
  }

  it("uses --text-faint for text only on disabled controls", () => {
    for (const [selector, declarations] of rules) {
      if (/(^|;|\s)color\s*:\s*var\(--text-faint\)/.test(declarations)) {
        assert.match(selector, /:disabled/, `${selector} sets color: var(--text-faint)`);
      }
    }
  });
});
