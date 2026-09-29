import { Marked } from "marked";

// A model's answer is untrusted text: a prompt injection can make it write
// anything. So the Markdown is formatted with three rules on top of the
// defaults, and the result is sanitized again before it's shown (see
// Markdown.tsx):
// - raw HTML is shown as text, never rendered;
// - images are left out — loading one sends a request, and an injected
//   prompt could put the conversation into its URL;
// - links go only to http(s) and mailto addresses, open in a new tab and
//   send no referrer.

const SAFE_LINK = /^(https?:|mailto:)/i;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const markdown = new Marked({
  gfm: true,
  breaks: true, // models end lines where they mean them to end
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    image({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!SAFE_LINK.test(href)) return label;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${label}</a>`;
    },
  },
});

/** A model's answer as HTML, formatted from its Markdown (unsanitized —
 * Markdown.tsx sanitizes it before showing it). */
export function markdownToHtml(text: string): string {
  return markdown.parse(text, { async: false });
}
