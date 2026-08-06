// /app/src/lib/errorFingerprint.ts
//
// Decides what counts as "the same bug". Pure — no I/O, no Prisma — so it can
// be tested exhaustively, which matters because this single decision is what
// makes the ErrorEvent table useful or useless.
//
// Too LOOSE and unrelated failures merge into one row, so the count is
// meaningless and the sample points at the wrong thing. Too TIGHT and every
// occurrence is a new row: "Order 123 not found" and "Order 456 not found"
// become two bugs, a crash loop becomes 5,000 rows, and the table fills the
// disk during exactly the incident it exists to explain.
//
// The rule: normalise the parts of a message that vary per occurrence (ids,
// uuids, quoted values, numbers, timestamps), keep the parts that identify the
// code path, and add the top stack frame so two different call sites throwing
// the same generic message ("Not found") stay distinct.

import { createHash } from "node:crypto";

/**
 * Replace per-occurrence detail with stable placeholders.
 *
 * Order matters: the more specific patterns run first, because a UUID also
 * matches the hex rule and a timestamp also contains numbers.
 */
export function normalizeErrorMessage(message: string): string {
  return (
    message
      // ISO-ish timestamps and dates
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
      .replace(/\d{4}-\d{2}-\d{2}/g, "<date>")
      // UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
      // Long hex blobs (hashes, tokens, object ids)
      .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
      // Quoted values -- usually the specific record that failed
      .replace(/'[^']*'/g, "'<v>'")
      .replace(/"[^"]*"/g, '"<v>"')
      // Emails and urls before the bare-number rule eats their digits
      .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
      .replace(/\bhttps?:\/\/\S+/g, "<url>")
      // Any remaining standalone number: ids, counts, amounts, ports
      .replace(/\b\d+(\.\d+)?\b/g, "<n>")
      // Collapse whitespace so formatting changes don't split a fingerprint
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The first stack frame that belongs to our code.
 *
 * node_modules and node internals are skipped: an error thrown deep inside
 * Prisma or Next is identified by OUR frame that triggered it, not by the
 * library's, or every database error in the app would share one fingerprint.
 */
export function topAppFrame(stack: string | undefined): string | null {
  if (!stack) return null;
  const lines = stack.split("\n").slice(1); // line 0 is the message
  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith("at ")) continue;
    if (line.includes("node_modules") || line.includes("node:internal")) continue;
    // Drop absolute paths and line/column -- they change with every deploy and
    // every edit above the throw site, which would fragment the fingerprint.
    return line
      .replace(/\(?\/[^\s)]*\/([^/\s)]+)\)?/g, "$1")
      .replace(/:\d+:\d+/g, "")
      .trim();
  }
  return null;
}

export interface Fingerprinted {
  fingerprint: string;
  normalized: string;
  stackTop: string | null;
}

/**
 * Identify an error. `context` may narrow the fingerprint further (e.g. the
 * route), but is deliberately NOT included by default: the same bug reached
 * from two routes is still one bug, and splitting on route would double every
 * row for a shared helper.
 */
export function fingerprintError(
  message: string,
  stack?: string,
  opts: { scope?: string } = {},
): Fingerprinted {
  const normalized = normalizeErrorMessage(message);
  const stackTop = topAppFrame(stack);
  const basis = [opts.scope ?? "", normalized, stackTop ?? ""].join("|");
  return {
    fingerprint: createHash("sha256").update(basis).digest("hex").slice(0, 32),
    normalized,
    stackTop,
  };
}
