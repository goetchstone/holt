// /app/src/lib/legacyArchive.ts
//
// Pure helpers for the Legacy Archive lookup (feature flag `legacyArchive`).
// The archive is a read-only snapshot of a client's previous system — search
// is the only operation. The where-builder reuses the canonical
// buildSearchFilter (AND-of-ORs across tokens) so "John Smith", phone
// fragments, and order numbers all match the way every other search does.

import { buildSearchFilter } from "@/lib/buildSearchFilter";
import type { Prisma } from "@prisma/client";

export const LEGACY_ARCHIVE_PAGE_SIZE = 25;

export const LEGACY_ARCHIVE_SEARCH_FIELDS = [
  "customerName",
  "companyName",
  "phone",
  "phone2",
  "address",
  "city",
  "zip",
  "customerCode",
  "orderNumber",
] as const;

export function buildLegacyArchiveWhere(search: string): Prisma.LegacyOrderWhereInput {
  return buildSearchFilter(search, [
    ...LEGACY_ARCHIVE_SEARCH_FIELDS,
  ]) as Prisma.LegacyOrderWhereInput;
}
