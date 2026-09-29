import { useMemo } from "react";
import DOMPurify from "dompurify";
import { markdownToHtml } from "./markdownToHtml";

// Belt and braces for text nobody vetted: after formatting (which already
// escapes raw HTML, drops images and keeps only safe links), only
// formatting tags and a few harmless attributes survive.
const SANITIZE = {
  ALLOWED_TAGS: [
    "p", "br", "hr", "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "a", "table", "thead", "tbody", "tr", "th", "td",
  ],
  ALLOWED_ATTR: ["href", "title", "target", "rel", "class", "start", "align"],
};

/** A model's answer, formatted from its Markdown. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(markdownToHtml(text), SANITIZE), [text]);
  return <div className={className ? `markdown ${className}` : "markdown"} dangerouslySetInnerHTML={{ __html: html }} />;
}
