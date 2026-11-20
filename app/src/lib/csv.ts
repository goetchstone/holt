// /app/src/lib/csv.ts
//
// Dependency-free CSV serialization for data export. Pure functions (no I/O,
// no Prisma) so they unit-test directly and can run anywhere. RFC-4180 quoting:
// a field is wrapped in double quotes when it contains a comma, quote, CR, or
// LF, and embedded quotes are doubled. Rows are joined with CRLF for maximum
// spreadsheet compatibility (Excel expects CRLF).

/**
 * Convert a single value to its CSV cell string (before quoting).
 *
 *   null / undefined -> ""            (empty cell)
 *   Date             -> ISO 8601      (stable, locale-independent)
 *   Array            -> JSON          (e.g. string[] alias columns)
 *   plain object     -> JSON          (e.g. a themeJson blob)
 *   wrapper object   -> String(v)     (Prisma.Decimal -> "123.45", etc.)
 *   primitive        -> String(v)
 *
 * Wrapper objects (Prisma.Decimal and friends) define a meaningful toString,
 * so String(v) yields their value; only plain objects need JSON to avoid the
 * useless "[object Object]".
 */
export function serializeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) === Object.prototype) return JSON.stringify(value);
    return String(value);
  }
  return String(value);
}

/**
 * CSV injection (OWASP): a spreadsheet runs a cell whose text starts with
 * = + - @ (or a tab or carriage return) as a formula. Customer, product and
 * note fields are user-entered, so any export can carry a payload. This is the
 * ONE neutraliser; `escapeCell` here and `csvCell` in csvExport.ts both call
 * it, so every export that emits through either helper gets it.
 *
 * Prefixes a single quote, which spreadsheets render as literal text. A string
 * that is wholly a plain number ("-12.50", "+3") is left alone so negative
 * amounts stay numbers; exports emit amounts via toFixed(2), never with a
 * thousands separator or currency symbol.
 */
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;
export function neutraliseFormulaCell(text: string): string {
  if (!/^[=+\-@\t\r]/.test(text)) return text;
  if (PLAIN_NUMBER.test(text)) return text;
  return `'${text}`;
}

/**
 * Neutralise every string value of a flat row object, for exporters that hand
 * rows to another serializer. Numbers, null and other types pass through.
 */
export function neutraliseRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "string" ? neutraliseFormulaCell(v) : v;
  }
  return out as T;
}

/**
 * Quote a cell for CSV. `isText` is false for a value that was a JS number,
 * which is never neutralised (a negative amount is a number, not a formula).
 */
export function escapeCell(raw: string, isText = true): string {
  const text = isText ? neutraliseFormulaCell(raw) : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialize an array of flat row objects to a CSV string. The header row is the
 * union of all keys across all rows, in first-seen order, so rows with sparse
 * or differing keys still line up under stable columns. Returns "" for an empty
 * input (caller can emit a header-only file or a "no rows" message).
 */
export function rowsToCsv(rows: ReadonlyArray<Record<string, unknown>>): string {
  if (rows.length === 0) return "";

  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }

  const lines: string[] = [headers.map((h) => escapeCell(h)).join(",")];
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => escapeCell(serializeCsvValue(row[h]), typeof row[h] !== "number"))
        .join(","),
    );
  }
  return lines.join("\r\n");
}
