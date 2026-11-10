// /app/src/lib/help/articles.ts
//
// Reads a help article's Markdown from app/help/<slug>.md and turns it into HTML for the
// app (GAP-30, DECISIONS 54). Server only: it reads the disk. The Dockerfile copies
// app/help into the image beside .next, since nothing imports these files.
//
// Only a slug from lib/help/catalog.ts reaches the disk, so a request can't name a path.
// The HTML is sanitized even though the words are ours: a link or tag in an article
// shouldn't be able to run anything in a signed-in session.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { helpArticle, type HelpArticle } from "@/lib/help/catalog";

export const HELP_DIR = path.join(process.cwd(), "help");

export interface RenderedHelpArticle extends HelpArticle {
  html: string;
  /** The words without markup, for search. */
  text: string;
}

const ALLOWED: sanitizeHtml.IOptions = {
  allowedTags: [
    "h2",
    "h3",
    "h4",
    "p",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "code",
    "pre",
    "blockquote",
    "a",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "hr",
    "br",
  ],
  allowedAttributes: { a: ["href", "title"] },
  // Links stay inside the app or go to the web; nothing else runs.
  allowedSchemes: ["https"],
  allowProtocolRelative: false,
};

/** Markdown to safe HTML. The title is the page's heading, so the article starts at h2. */
export function renderHelpMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true });
  return sanitizeHtml(html, ALLOWED);
}

function plainText(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
}

export async function readHelpArticle(slug: unknown): Promise<RenderedHelpArticle | null> {
  const article = helpArticle(slug);
  if (!article) return null;
  const markdown = await readFile(path.join(HELP_DIR, `${article.slug}.md`), "utf8");
  const html = renderHelpMarkdown(markdown);
  return { ...article, html, text: plainText(html) };
}
