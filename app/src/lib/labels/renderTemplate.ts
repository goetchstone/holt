// /app/src/lib/labels/renderTemplate.ts
//
// Fill a ZPL label template (LabelTemplate.zplTemplate) with a label's fields.
// Pure: every label renders through it, so a field means the same on all of them.
//
// Each LabelTemplate.context has its own fields, listed once here (rule 37),
// so the template editor can show what a template may use:

import Mustache from "mustache";

const PRODUCT_FIELDS = [
  "name",
  "sku",
  "vendor",
  "barcode",
  "width",
  "depth",
  "height",
  "baseRetail",
  // The cost in the store's own code (lib/labels/costCode.ts). Use this on
  // anything a customer can read: baseCost prints the real number.
  "costCode",
  "baseCost",
  // The product's picture, if the template gives it a size (photoDots).
  "photo",
] as const;

export const LABEL_FIELDS = {
  PRODUCT: PRODUCT_FIELDS,
  // baseRetail is what the register charges; wasPrice is Product.wasPrice.
  SALE: [...PRODUCT_FIELDS, "wasPrice", "saving", "savingPercent"],
  // The wording the law asks for is the template's; lawText is the product's own.
  LAW: ["name", "sku", "vendor", "barcode", "width", "depth", "height", "lawText"],
  SOLD: [
    "name",
    "sku",
    "vendor",
    "quantity",
    "orderNumber",
    "customer",
    "customerLastName",
    "soldOn",
    "salesperson",
  ],
  LOCATION: ["locationCode", "locationName", "path", "store", "barcode"],
  BOX: ["name", "sku", "box", "of", "barcode", "poNumber"],
} as const;

/** What the template screen calls each context. */
export const LABEL_CONTEXT_NAMES: Record<keyof typeof LABEL_FIELDS, string> = {
  PRODUCT: "Price tag",
  SALE: "Sale tag",
  LAW: "Law tag",
  SOLD: "Sold tag",
  LOCATION: "Place label",
  BOX: "Box label",
};

export type LabelContext = keyof typeof LABEL_FIELDS;

export function isLabelContext(value: unknown): value is LabelContext {
  return typeof value === "string" && Object.hasOwn(LABEL_FIELDS, value);
}

/**
 * ZPL this code built, which goes on the label as it is. Everything else is text
 * from a record, and safeField keeps it from being read as commands.
 */
export class ZplGraphic {
  constructor(readonly zpl: string) {}
  toString(): string {
    return this.zpl;
  }
}

/**
 * ZPL commands start with ^ or ~, so a value carrying one (a product named
 * "50^ off") would end the field and run whatever follows as a command.
 * Replaced with a space; nothing a label needs to print uses them.
 */
function safeField(value: unknown): string {
  if (value instanceof ZplGraphic) return value.zpl;
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
