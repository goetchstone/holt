// /app/src/lib/cms/requestBody.ts
//
// Pure request-body validation for the CMS admin API (CLAUDE.md rule 14: the
// branching/coercion logic lives here and is unit-tested; the handlers stay
// thin). Throws Error with a user-facing message on invalid input so handlers
// can surface it via getErrorMessage.

import { z } from "zod";
import { blocksSchema } from "./blocks";
import { menuItemsSchema, type MenuItem } from "./menu";

// Lowercase words separated by - or / (supports nested page paths like a/b).
const SLUG_RE = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

const cmsStatus = z.enum(["DRAFT", "PUBLISHED"]);

export const pageInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required"),
  slug: z
    .string()
    .trim()
    .min(1, "Slug is required")
    .regex(SLUG_RE, "Slug must be lowercase words separated by - or /"),
  status: cmsStatus.default("DRAFT"),
  isHome: z.boolean().default(false),
  blocks: blocksSchema.default([]),
  seoTitle: z.string().trim().nullish(),
  seoDescription: z.string().trim().nullish(),
});
export type PageInput = z.infer<typeof pageInputSchema>;

export const postInputSchema = pageInputSchema.omit({ isHome: true }).extend({
  excerpt: z.string().trim().nullish(),
  coverImageUrl: z.string().trim().nullish(),
  author: z.string().trim().nullish(),
  category: z.string().trim().nullish(),
  tags: z.array(z.string().trim()).default([]),
});
export type PostInput = z.infer<typeof postInputSchema>;

function firstIssueMessage(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

export function parsePageInput(body: unknown): PageInput {
  const result = pageInputSchema.safeParse(body);
  if (!result.success) throw new Error(firstIssueMessage(result.error, "Invalid page"));
  return result.data;
}

export function parsePostInput(body: unknown): PostInput {
  const result = postInputSchema.safeParse(body);
  if (!result.success) throw new Error(firstIssueMessage(result.error, "Invalid post"));
  return result.data;
}

export function parseMenuInput(body: unknown): MenuItem[] {
  const items = (body as { items?: unknown } | null)?.items;
  const result = menuItemsSchema.safeParse(items);
  if (!result.success) throw new Error("Invalid menu items");
  return result.data;
}
