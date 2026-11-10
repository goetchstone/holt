// /app/src/pages/api/help/article.ts
//
// The help article for a screen, for the "?" panel (GAP-30): GET ?screen=/app/... answers
// { slug, title, html }, or 404 when that screen has no article yet. Every staff member
// holds staff.self, so anyone signed in can read help.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { helpForScreen } from "@/lib/help/catalog";
import { readHelpArticle } from "@/lib/help/articles";
import { logError } from "@/lib/logger";

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }
  const article = helpForScreen(req.query.screen);
  if (!article) return res.status(404).json({ error: "This screen has no help article yet." });
  try {
    const rendered = await readHelpArticle(article.slug);
    if (!rendered) return res.status(404).json({ error: "This screen has no help article yet." });
    return res.json({ slug: rendered.slug, title: rendered.title, html: rendered.html });
  } catch (error) {
    logError("Help article failed to load", error, { slug: article.slug });
    return res.status(500).json({ error: "The help article couldn't be loaded." });
  }
}

export default requirePermission("staff.self", handler);
