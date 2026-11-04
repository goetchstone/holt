// /app/src/lib/savedRecord.ts
//
// Add or edit. A list's "Add New" opens its form with an empty record ({}), so
// a form that asked "was I given a record?" took every new one for an edit and
// saved it to /api/<things>/undefined: adding a category, type, department,
// label template or printer failed with "Invalid ... ID" (found 2026-11-02).
// A record is being edited when it has an id.

export function isSavedRecord<T extends { id?: number | null }>(
  record: T | null | undefined,
): record is T & { id: number } {
  return record?.id != null;
}
