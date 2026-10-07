// /app/src/lib/imports/transforms.ts
//
// The SMALL, fixed set of value transforms a declarative import definition
// can apply to a mapped field, after value-mapping and before validation
// (lib/imports/engine.ts). Deliberately not a DSL — six named, single-
// purpose coercions. Add a seventh only for a concrete importer that
// genuinely needs it; note the justification here when you do.
//
//   TRIM      — strip leading/trailing whitespace. Every hand-exported CSV
//               this codebase has seen pads or misaligns at least one
//               column, and stray whitespace silently breaks exact-match
//               value mapping and natural-key equality downstream.
//   UPPERCASE — canonicalize casing (state codes, SKUs, status-like
//               strings) before it's used as a natural key or compared
//               case-insensitively upstream.
//   LOWERCASE — same, the other direction (emails, slugs).
//   NUMBER    — generic numeric coercion, the declarative-config analogue
//               of importHelpers.safeFloat.
//   DATE      — generic date coercion, the declarative-config analogue of
//               importHelpers.safeDate. Produces an ISO string so a preview
//               payload stays JSON-safe and a caller can hand it straight
//               to a Prisma DateTime field.
//   CURRENCY  — money-specific numeric coercion: strips "$" and thousands
//               separators, and treats a parenthesized amount as negative
//               (the common accounting-export convention: "(50.00)" ==
//               -50). Kept separate from NUMBER because applying
//               parenthesis-as-negative to an ordinary quantity or count
//               column would be wrong, and NUMBER staying naive keeps that
//               transform's behavior predictable for non-money fields.
//
// Pure. No Prisma, no I/O — every transform is a total function from one
// string to a value-or-error.

import type { ImportTransformKey } from "@/lib/imports/types";

export interface TransformResult {
  value: string | number | undefined;
  error?: string;
}

function trim(raw: string): TransformResult {
  return { value: raw.trim() };
}

function uppercase(raw: string): TransformResult {
  return { value: raw.trim().toUpperCase() };
}

function lowercase(raw: string): TransformResult {
  return { value: raw.trim().toLowerCase() };
}

function number(raw: string): TransformResult {
  const cleaned = raw.trim().replace(/[^0-9.\-]+/g, "");
  const n = Number.parseFloat(cleaned);
  if (cleaned === "" || !Number.isFinite(n)) {
    return { value: undefined, error: `"${raw}" is not a valid number` };
  }
  return { value: n };
}

function date(raw: string): TransformResult {
  const parsed = new Date(raw.trim());
  if (Number.isNaN(parsed.getTime())) {
    return { value: undefined, error: `"${raw}" is not a valid date` };
  }
  return { value: parsed.toISOString() };
}

function currency(raw: string): TransformResult {
  const trimmed = raw.trim();
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[()$,]/g, "").trim();
  const n = Number.parseFloat(cleaned);
  if (cleaned === "" || !Number.isFinite(n)) {
    return { value: undefined, error: `"${raw}" is not a valid currency amount` };
  }
  return { value: negative ? -Math.abs(n) : n };
}

const TRANSFORMS: Record<ImportTransformKey, (raw: string) => TransformResult> = {
  TRIM: trim,
  UPPERCASE: uppercase,
  LOWERCASE: lowercase,
  NUMBER: number,
  DATE: date,
  CURRENCY: currency,
};

export const TRANSFORM_KEYS: readonly ImportTransformKey[] = Object.keys(
  TRANSFORMS,
) as ImportTransformKey[];

export function isImportTransformKey(value: string): value is ImportTransformKey {
  return Object.prototype.hasOwnProperty.call(TRANSFORMS, value);
}

export function applyTransform(key: ImportTransformKey, raw: string): TransformResult {
  return TRANSFORMS[key](raw);
}
