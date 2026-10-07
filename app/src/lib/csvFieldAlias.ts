// /app/src/lib/csvFieldAlias.ts
//
// Shared CSV header-alias resolver used by the admin/import normalizers
// (categories, departments, types, vendors). Source CSVs name the same field
// inconsistently ("name" vs "Name" vs "categoryName"), so each importer matches
// a candidate value against a case-insensitive alias list rather than a single
// header. Returns the first non-empty, trimmed match or "".

export function findAliasValue(row: Record<string, unknown>, aliases: string[]): string {
  const keys = Object.keys(row);
  for (const alias of aliases) {
    const foundKey = keys.find((key) => key.trim().toLowerCase() === alias.toLowerCase());
    if (foundKey && row[foundKey]) {
      const value = String(row[foundKey]).trim();
      if (value) return value;
    }
  }
  return "";
}
