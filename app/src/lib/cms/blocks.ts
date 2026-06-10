// /app/src/lib/cms/blocks.ts
//
// Shared client/server contract (CLAUDE.md rule 7) for CMS block content.
// Page.blocks and Post.blocks are stored as a typed JSON array; the admin
// editor builds these objects and the public renderer consumes them, so the
// shape MUST be defined once and validated on both sides. Adding a block type
// is a single change here: add its schema, add it to the union, give it a
// label and a factory default.
//
// Author-supplied HTML (richText, embed) is rendered as-is by the public
// renderer; authors are trusted back-office staff. Sanitize at the render
// boundary if untrusted authors are ever introduced.

import { z } from "zod";

export const BLOCK_TYPES = [
  "hero",
  "features",
  "stats",
  "quote",
  "richText",
  "image",
  "gallery",
  "cta",
  "embed",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const ALIGNMENTS = ["left", "center", "right"] as const;
export type Alignment = (typeof ALIGNMENTS)[number];

// Section background variant. Lets content alternate light/dark/tinted bands so
// a page reads with rhythm instead of a flat white scroll. The renderer maps
// each to a coordinated background + text-color set (see BlockRenderer).
export const SECTION_BACKGROUNDS = ["default", "muted", "dark"] as const;
export type SectionBackground = (typeof SECTION_BACKGROUNDS)[number];

const id = z.string().min(1);

export const heroBlockSchema = z.object({
  id,
  type: z.literal("hero"),
  // Small letterspaced gold caps line above the heading ("FREE TOOL", a brand
  // descriptor). Empty = not rendered.
  eyebrow: z.string().default(""),
  heading: z.string().default(""),
  // Optional second headline line rendered in the gold accent color
  // ("Technology partners." / "Not vendors."). Empty = single-line heading.
  headingAccent: z.string().default(""),
  subheading: z.string().default(""),
  // Small brand mark centered above the eyebrow (URL). Distinct from imageUrl,
  // which is the full-bleed background image.
  markUrl: z.string().default(""),
  imageUrl: z.string().default(""),
  ctaLabel: z.string().default(""),
  ctaHref: z.string().default(""),
  // Optional secondary (outline) button, for two-CTA heros.
  ctaLabel2: z.string().default(""),
  ctaHref2: z.string().default(""),
  align: z.enum(ALIGNMENTS).default("center"),
});

export const richTextBlockSchema = z.object({
  id,
  type: z.literal("richText"),
  html: z.string().default(""),
  // Same band treatment as the other section blocks; "dark" inverts the prose
  // colors so text stays readable on dark sites.
  background: z.enum(SECTION_BACKGROUNDS).default("default"),
});

export const imageBlockSchema = z.object({
  id,
  type: z.literal("image"),
  url: z.string().default(""),
  alt: z.string().default(""),
  caption: z.string().default(""),
});

export const galleryImageSchema = z.object({
  url: z.string().default(""),
  alt: z.string().default(""),
});

export const galleryBlockSchema = z.object({
  id,
  type: z.literal("gallery"),
  images: z.array(galleryImageSchema).default([]),
});

export const ctaBlockSchema = z.object({
  id,
  type: z.literal("cta"),
  eyebrow: z.string().default(""),
  heading: z.string().default(""),
  body: z.string().default(""),
  buttonLabel: z.string().default(""),
  buttonHref: z.string().default(""),
  // Default "muted" preserves the prior linen CTA band.
  background: z.enum(SECTION_BACKGROUNDS).default("muted"),
});

export const embedBlockSchema = z.object({
  id,
  type: z.literal("embed"),
  html: z.string().default(""),
});

export const featureItemSchema = z.object({
  title: z.string().default(""),
  body: z.string().default(""),
});

export const featuresBlockSchema = z.object({
  id,
  type: z.literal("features"),
  eyebrow: z.string().default(""),
  heading: z.string().default(""),
  subheading: z.string().default(""),
  items: z.array(featureItemSchema).default([]),
  background: z.enum(SECTION_BACKGROUNDS).default("default"),
});

export const statItemSchema = z.object({
  value: z.string().default(""),
  label: z.string().default(""),
});

export const statsBlockSchema = z.object({
  id,
  type: z.literal("stats"),
  items: z.array(statItemSchema).default([]),
  // "stats" = big serif numbers grid; "checklist" = single inline row of
  // check-marked claims (the akritos.com trust strip).
  variant: z.enum(["stats", "checklist"]).default("stats"),
  // Default "dark" preserves the prior navy stat band.
  background: z.enum(SECTION_BACKGROUNDS).default("dark"),
});

export const quoteBlockSchema = z.object({
  id,
  type: z.literal("quote"),
  eyebrow: z.string().default(""),
  quote: z.string().default(""),
  attribution: z.string().default(""),
  background: z.enum(SECTION_BACKGROUNDS).default("default"),
});

export const contentBlockSchema = z.discriminatedUnion("type", [
  heroBlockSchema,
  featuresBlockSchema,
  statsBlockSchema,
  quoteBlockSchema,
  richTextBlockSchema,
  imageBlockSchema,
  galleryBlockSchema,
  ctaBlockSchema,
  embedBlockSchema,
]);

export type ContentBlock = z.infer<typeof contentBlockSchema>;
export type HeroBlock = z.infer<typeof heroBlockSchema>;
export type RichTextBlock = z.infer<typeof richTextBlockSchema>;
export type ImageBlock = z.infer<typeof imageBlockSchema>;
export type GalleryBlock = z.infer<typeof galleryBlockSchema>;
export type CtaBlock = z.infer<typeof ctaBlockSchema>;
export type EmbedBlock = z.infer<typeof embedBlockSchema>;
export type FeaturesBlock = z.infer<typeof featuresBlockSchema>;
export type StatsBlock = z.infer<typeof statsBlockSchema>;
export type QuoteBlock = z.infer<typeof quoteBlockSchema>;

export const blocksSchema = z.array(contentBlockSchema);

// Human-readable labels for the editor's "add block" menu.
export const BLOCK_LABELS: Record<BlockType, string> = {
  hero: "Hero",
  features: "Features",
  stats: "Stats",
  quote: "Quote",
  richText: "Text",
  image: "Image",
  gallery: "Gallery",
  cta: "Call to action",
  embed: "Embed",
};

/**
 * Parse a stored blocks value (Prisma Json, possibly null) into a validated
 * array for RENDERING. Lenient by design: each block is validated on its own
 * and an invalid/unknown one is dropped rather than discarding the whole page.
 * This keeps a page from going blank when content references a block type the
 * running code does not yet know (e.g. mid-deploy) or when one block is
 * corrupt. Writes stay strict via `blocksSchema` in lib/cms/requestBody.ts.
 */
export function parseBlocks(value: unknown): ContentBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: ContentBlock[] = [];
  for (const item of value) {
    const result = contentBlockSchema.safeParse(item);
    if (result.success) blocks.push(result.data);
  }
  return blocks;
}

/** Build a new block of the given type with empty defaults, for the editor. */
export function createBlock(type: BlockType, blockId: string): ContentBlock {
  switch (type) {
    case "hero":
      return heroBlockSchema.parse({ id: blockId, type });
    case "features":
      return featuresBlockSchema.parse({ id: blockId, type });
    case "stats":
      return statsBlockSchema.parse({ id: blockId, type });
    case "quote":
      return quoteBlockSchema.parse({ id: blockId, type });
    case "richText":
      return richTextBlockSchema.parse({ id: blockId, type });
    case "image":
      return imageBlockSchema.parse({ id: blockId, type });
    case "gallery":
      return galleryBlockSchema.parse({ id: blockId, type });
    case "cta":
      return ctaBlockSchema.parse({ id: blockId, type });
    case "embed":
      return embedBlockSchema.parse({ id: blockId, type });
  }
}
