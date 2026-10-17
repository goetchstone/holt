// /app/src/lib/labels/renderTemplate.ts
//
// Fill a ZPL label template (LabelTemplate.zplTemplate) with a label's fields.
// Pure: the product, place and box labels all render through it, so a field
// means the same on all three.
//
// Each LabelTemplate.context has its own fields, listed once here (rule 37),
// so the template editor can show what a template may use:

import Mustache from "mustache";

export const LABEL_FIELDS = {
  PRODUCT: [
    "name",
    "sku",
    "vendor",
    "barcode",
    "width",
    "depth",
    "height",
    "baseCost",
    "baseRetail",
  ],
  LOCATION: ["locationCode", "locationName", "path", "store", "barcode"],
  BOX: ["name", "sku", "box", "of", "barcode", "poNumber"],
} as const;

export type LabelContext = keyof typeof LABEL_FIELDS;

export function isLabelContext(value: unknown): value is LabelContext {
  return typeof value === "string" && Object.hasOwn(LABEL_FIELDS, value);
}

/**
 * ZPL commands start with ^ or ~, so a value carrying one (a product named
 * "50^ off") would end the field and run whatever follows as a command.
 * Replaced with a space; nothing a label needs to print uses them.
 */
function safeField(value: unknown): string {
  return String(value ?? "").replace(/[\^~]/g, " ");
}

/**
 * Mustache, as the templates were always written for, with its HTML escaping
 * replaced by ZPL's: a label is not a web page, and Mustache printed "&amp;"
 * for "&". Unknown fields render empty.
 */
export function renderTemplate(zpl: string, fields: Record<string, unknown>): string {
  return renderWithConfig(zpl, fields, {}, { escape: safeField });
}

// Mustache 4.2 takes a config object as its fourth argument; @types/mustache
// predates it.
const renderWithConfig = Mustache.render as unknown as (
  template: string,
  view: Record<string, unknown>,
  partials: Record<string, string>,
  config: { escape: (value: unknown) => string },
) => string;
