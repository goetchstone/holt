// /app/src/lib/cms/sanitize.ts
//
// Server-side sanitizer for author-supplied CMS HTML (richText / embed blocks).
// Defense in depth: even though CMS authoring is ADMIN-gated, the public site
// must never render an injected <script>, event handler, or javascript: URL.
// sanitize-html strips scripts/on*-handlers/unknown schemes by default; we
// additionally restrict iframe embeds to a safe provider allowlist and force
// rel="noopener noreferrer" on links. Server-only (BlockRenderer is a server
// component), so this never ships to the browser bundle.

import sanitizeHtml from "sanitize-html";

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "span",
    "div",
    "blockquote",
    "pre",
    "code",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "b",
    "i",
    "u",
    "s",
    "a",
    "br",
    "hr",
    "img",
    "figure",
    "figcaption",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "iframe",
  ],
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    iframe: [
      "src",
      "width",
      "height",
      "title",
      "allow",
      "allowfullscreen",
      "frameborder",
      "loading",
    ],
    "*": ["class"],
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  // Embeds (the embed block) are restricted to known-safe providers; any other
  // iframe src is dropped.
  allowedIframeHostnames: [
    "www.youtube.com",
    "youtube.com",
    "www.youtube-nocookie.com",
    "player.vimeo.com",
    "www.google.com",
    "maps.google.com",
    "www.loom.com",
  ],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }),
  },
};

/** Sanitize CMS author HTML for safe rendering on the public site. */
export function sanitizeCmsHtml(html: string): string {
  return sanitizeHtml(html ?? "", OPTIONS);
}
