// /app/src/lib/pricing/markup.ts
//
// Which markup prices a product's retail from its cost (GAP-06). A markup is a
// multiplier: 2.2 means retail is cost x 2.2. Three places can carry one -- the
// vendor (Vendor.defaultMarkup), the category (Category.defaultMarkup) and the
// store (AppSettings.pricing.defaultMarkup) -- and the store says whether the
// vendor's or the category's wins. The store's is the fallback either way.
//
// Unset is null, and so is anything that isn't a finite number above zero: a 0x
// or negative markup is meaningless, and inventing a retail price from one is
// worse than showing none (USE-04). Pure, so the screens and the server share it.

/** Which of vendor and category wins when both carry a markup. Store settings. */
export const MARKUP_PRECEDENCES = ["VENDOR_FIRST", "CATEGORY_FIRST"] as const;
export type MarkupPrecedence = (typeof MARKUP_PRECEDENCES)[number];

/** The default keeps every price a vendor markup gives today. */
export const DEFAULT_MARKUP_PRECEDENCE: MarkupPrecedence = "VENDOR_FIRST";

export const MARKUP_PRECEDENCE_LABELS: Record<MarkupPrecedence, string> = {
  VENDOR_FIRST: "Vendor's markup first, then the category's",
  CATEGORY_FIRST: "Category's markup first, then the vendor's",
};

export function isMarkupPrecedence(value: unknown): value is MarkupPrecedence {
  return typeof value === "string" && (MARKUP_PRECEDENCES as readonly string[]).includes(value);
}

export type MarkupSource = "vendor" | "category" | "store";

export interface ResolvedMarkup {
  multiplier: number;
  source: MarkupSource;
}

/** A markup as a number above zero, or null for unset. Accepts a Decimal's string. */
export function markupValue(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "boolean") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface MarkupInputs {
  vendorMarkup?: unknown;
  categoryMarkup?: unknown;
  storeMarkup?: unknown;
  precedence?: MarkupPrecedence;
}

/** The markup that applies, and where it came from; null when none is set. */
export function resolveMarkup({
  vendorMarkup,
  categoryMarkup,
  storeMarkup,
  precedence = DEFAULT_MARKUP_PRECEDENCE,
}: MarkupInputs): ResolvedMarkup | null {
  const vendor = markupValue(vendorMarkup);
  const category = markupValue(categoryMarkup);
  const order: [MarkupSource, number | null][] =
    precedence === "CATEGORY_FIRST"
      ? [
          ["category", category],
          ["vendor", vendor],
        ]
      : [
          ["vendor", vendor],
          ["category", category],
        ];
  order.push(["store", markupValue(storeMarkup)]);
  for (const [source, multiplier] of order) {
    if (multiplier !== null) return { multiplier, source };
  }
  return null;
}

/** Why a markup someone typed can't be saved, or null when it can (null clears). */
export function markupProblem(raw: unknown): string | null {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return "A markup must be a multiplier above zero (2.2 means cost x 2.2), or empty for none.";
  }
  // Decimal(8,4): four places, under 10,000x.
  if (raw >= 10000) return "A markup must be under 10,000.";
  return null;
}

/** The same markup, to the four places Category.defaultMarkup keeps; unset equals unset. */
export function sameMarkup(a: unknown, b: unknown): boolean {
  const x = markupValue(a);
  const y = markupValue(b);
  if (x === null || y === null) return x === y;
  return Math.round(x * 10000) === Math.round(y * 10000);
}

/** A configurator style's markup, as /api/pricing/products resolves it per style. */
export interface StyleMarkup {
  markup?: number | null;
  markupSource?: MarkupSource | null;
}

/**
 * The markup that prices one style: its own resolved markup (its category's may
 * differ from its vendor's), or the vendor-level one when the response carried
 * none -- nothing chosen yet, or an older response.
 */
export function styleMarkup(
  style: StyleMarkup | null | undefined,
  vendorMarkup: number | null,
): number | null {
  return style && style.markup !== undefined ? style.markup : vendorMarkup;
}

/** "category's" for a suggestion's label, or "" when unknown. */
export function markupSourceLabel(style: StyleMarkup | null | undefined): string {
  const source = style?.markupSource;
  return source ? `${source}'s` : "";
}

/** "Suggested Retail (3x, category's)": the configurators' label for a style's suggested price. */
export function suggestedRetailLabel(
  markup: number | null,
  style: StyleMarkup | null | undefined,
): string {
  const source = markupSourceLabel(style);
  return `Suggested Retail (${markup ?? "\u2014"}x${source ? `, ${source}` : ""})`;
}
