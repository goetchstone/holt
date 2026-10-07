// /app/src/lib/excelUtils.ts
//
// Utility for safely extracting cell values from import data rows.
// Used by the POS product import pipeline.

/**
 * Extract a value from a data row by key name. Accepts either a single
 * key string or an array of possible key names (tries each in order).
 * Matching is case-insensitive and trims whitespace from both the alias
 * and the row keys so that minor header variations ("QTY" vs "Qty",
 * " Quantity " vs "Quantity") are handled transparently.
 * Returns an empty string if no matching key is found or the value is empty.
 */
export function getCellValue(row: Record<string, unknown>, key: string | string[]): string {
  const aliases = Array.isArray(key) ? key : [key];

  // Build a lookup from normalized row key to original key (once per call)
  const normalizedMap = new Map<string, string>();
  for (const k of Object.keys(row)) {
    normalizedMap.set(k.trim().toLowerCase(), k);
  }

  for (const alias of aliases) {
    const norm = alias.trim().toLowerCase();

    // Try exact match first (fast path)
    if (row[alias] !== undefined && row[alias] !== null && row[alias] !== "") {
      return String(row[alias]);
    }

    // Fall back to case-insensitive + trimmed match
    const originalKey = normalizedMap.get(norm);
    if (originalKey !== undefined) {
      const val = row[originalKey];
      if (val !== undefined && val !== null && val !== "") {
        return String(val);
      }
    }
  }

  return "";
}
