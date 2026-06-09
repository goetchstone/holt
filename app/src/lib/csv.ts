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

function escapeCell(raw: string): string {
  return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
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

  const lines: string[] = [headers.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(serializeCsvValue(row[h]))).join(","));
  }
  return lines.join("\r\n");
}
