// /app/__tests__/legacyArchive.test.ts
//
// Pure tests for the Legacy Archive search builder: pins the AND-of-ORs
// contract (every token must match at least one field) and the searched
// field list — dropping a field from the list silently breaks lookup for
// that column, so the list itself is part of the contract.

import {
  buildLegacyArchiveWhere,
  LEGACY_ARCHIVE_SEARCH_FIELDS,
  LEGACY_ARCHIVE_PAGE_SIZE,
} from "@/lib/legacyArchive";

describe("buildLegacyArchiveWhere", () => {
  it("builds AND-of-ORs: every token must hit at least one field", () => {
    const where = buildLegacyArchiveWhere("John Smith") as {
      AND: { OR: Record<string, unknown>[] }[];
    };
    expect(where.AND).toHaveLength(2);
    for (const tokenClause of where.AND) {
      expect(tokenClause.OR).toHaveLength(LEGACY_ARCHIVE_SEARCH_FIELDS.length);
    }
  });

  it("searches the contracted field set", () => {
    expect([...LEGACY_ARCHIVE_SEARCH_FIELDS]).toEqual([
      "customerName",
      "companyName",
      "phone",
      "phone2",
      "address",
      "city",
      "zip",
      "customerCode",
      "orderNumber",
    ]);
  });

  it("matches case-insensitively", () => {
    const where = buildLegacyArchiveWhere("acme") as {
      AND: { OR: { customerName?: { contains: string; mode: string } }[] }[];
    };
    const first = where.AND[0].OR.find((c) => c.customerName);
    expect(first?.customerName).toMatchObject({ contains: "acme", mode: "insensitive" });
  });

  it("page size stays at the contract value", () => {
    expect(LEGACY_ARCHIVE_PAGE_SIZE).toBe(25);
  });
});
