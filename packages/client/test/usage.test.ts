import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { compactCount, describeUsage } from "../src/usage.js";

describe("describeUsage", () => {
  it("summarizes tokens, speed and context", () => {
    const view = describeUsage({ prompt_tokens: 1200, completion_tokens: 100, generation_ms: 2000, context_window: 4096 })!;
    assert.equal(view.tokens, "1,200 in · 100 out");
    assert.equal(view.tokensPerSecond, 50);
    assert.equal(view.level, "ok");
    assert.equal(view.contextShort, "1.2k/4.1k ctx");
    assert.equal(view.summary, "1,200 in · 100 out · 50 tok/s · context 4,096 (29% used)");
    assert.equal(view.warning, null);
  });

  it("warns when the prompt nears or fills the context window", () => {
    const near = describeUsage({ prompt_tokens: 3400, completion_tokens: 10, generation_ms: null, context_window: 4096 })!;
    assert.equal(near.level, "near");
    assert.match(near.warning!, /83% of the model's context window \(3,400 of 4,096 tokens\)/);
    const full = describeUsage({ prompt_tokens: 4090, completion_tokens: 10, generation_ms: null, context_window: 4096 })!;
    assert.equal(full.level, "full");
    assert.match(full.warning!, /probably cut off/);
  });

  it("copes with what backends leave out", () => {
    assert.equal(describeUsage(null), null);
    assert.equal(describeUsage(undefined), null);
    const cloud = describeUsage({ prompt_tokens: 50, completion_tokens: 20, generation_ms: null, context_window: null })!;
    assert.equal(cloud.level, null);
    assert.equal(cloud.contextShort, null);
    assert.equal(cloud.summary, "50 in · 20 out");
    const bare = describeUsage({ prompt_tokens: null, completion_tokens: null, generation_ms: null, context_window: 8192 })!;
    assert.equal(bare.summary, "context 8,192");
  });

  it("compacts counts", () => {
    assert.deepEqual([950, 3900, 12000, 131072].map(compactCount), ["950", "3.9k", "12k", "131k"]);
  });

  it("catches a prompt Ollama cut, even though the token count looks modest", () => {
    // 1,500 characters into a 256-token window: Ollama reports only the
    // 130 tokens it kept.
    const cut = describeUsage({ prompt_tokens: 130, completion_tokens: 15, generation_ms: 150, context_window: 256, prompt_chars: 1500 })!;
    assert.equal(cut.level, "full");
    assert.match(cut.summary, /context 256 \(prompt cut off\)/);
    assert.match(cut.warning!, /1,500 characters\) doesn't fit .* cut it to 130 tokens/);
    // The same token count from a short prompt is fine.
    const fits = describeUsage({ prompt_tokens: 130, completion_tokens: 15, generation_ms: 150, context_window: 256, prompt_chars: 500 })!;
    assert.equal(fits.level, "ok");
  });
});
