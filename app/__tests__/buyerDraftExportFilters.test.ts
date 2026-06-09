// /app/__tests__/buyerDraftExportFilters.test.ts
//
// A-grade unit tests for the buyer-drafts export WHERE builders. The
// helpers are pure — given a query-shape object they return a Prisma
// WHERE shape. Tests pin every branch of the "when does the legacy
// READY default fire?" semantics that drove user-reported bug
// 2026-05-14 (clicking Export against a CLOSED Buy returned 0 rows
// because the endpoint defaulted to status=READY on bare GETs).

import {
  buildItemsWhere,
  buildPosWhere,
  buildWorkbookItemsWhere,
  parseExportQuery,
} from "@/lib/buyerDraftExportFilters";

describe("parseExportQuery", () => {
  it("parses an empty query into all-null fields", () => {
    expect(parseExportQuery({})).toEqual({
      ids: null,
      itemStatus: null,
      poStatus: null,
      vendorId: null,
      buyId: null,
    });
  });

  it("parses a comma-separated id list", () => {
    expect(parseExportQuery({ ids: "1,2,3" }).ids).toEqual([1, 2, 3]);
  });

  it("strips whitespace and rejects non-positive ids", () => {
    expect(parseExportQuery({ ids: "  4  , 0 , -1 , 5  " }).ids).toEqual([4, 5]);
  });

  it("returns null when no ids parse as positive integers", () => {
    expect(parseExportQuery({ ids: "abc,xyz" }).ids).toBeNull();
    expect(parseExportQuery({ ids: "" }).ids).toBeNull();
    expect(parseExportQuery({ ids: "  " }).ids).toBeNull();
  });

  it("accepts the literal 'unassigned' buyId token", () => {
    expect(parseExportQuery({ buyId: "unassigned" }).buyId).toBe("unassigned");
    expect(parseExportQuery({ buyId: "UNASSIGNED" }).buyId).toBe("unassigned");
  });

  it("parses a numeric buyId", () => {
    expect(parseExportQuery({ buyId: "42" }).buyId).toBe(42);
  });

  it("rejects garbage buyId values", () => {
    expect(parseExportQuery({ buyId: "not-a-number" }).buyId).toBeNull();
    expect(parseExportQuery({ buyId: "0" }).buyId).toBeNull();
    expect(parseExportQuery({ buyId: "-3" }).buyId).toBeNull();
  });

  it("validates item status against the known enum", () => {
    expect(parseExportQuery({ status: "DRAFT" }).itemStatus).toBe("DRAFT");
    expect(parseExportQuery({ status: "FULFILLED" }).itemStatus).toBe("FULFILLED");
    expect(parseExportQuery({ status: "WRONG" }).itemStatus).toBeNull();
    expect(parseExportQuery({ status: "draft" }).itemStatus).toBeNull(); // case-sensitive
  });
});

describe("buildItemsWhere — legacy production-handoff defaults", () => {
  it("applies READY default when query is bare (no ids, no buyId, no status)", () => {
    expect(buildItemsWhere({})).toEqual({ status: "READY" });
  });

  it("respects an explicit status param against a bare query", () => {
    expect(buildItemsWhere({ status: "DRAFT" })).toEqual({ status: "DRAFT" });
    expect(buildItemsWhere({ status: "FULFILLED" })).toEqual({ status: "FULFILLED" });
  });

  it("ignores invalid status and falls back to READY default", () => {
    expect(buildItemsWhere({ status: "NOPE" })).toEqual({ status: "READY" });
  });
});

describe("buildItemsWhere — id scoping", () => {
  it("scopes by ids with NO status default", () => {
    expect(buildItemsWhere({ ids: "10,20,30" })).toEqual({ id: { in: [10, 20, 30] } });
  });

  it("respects an explicit status alongside ids", () => {
    expect(buildItemsWhere({ ids: "5", status: "DRAFT" })).toEqual({
      id: { in: [5] },
      status: "DRAFT",
    });
  });
});

describe("buildItemsWhere — buy scoping (the user-reported bug)", () => {
  it("scopes to a specific buy via draftPo.buyId with NO status default", () => {
    // This is the failure-mode fix: pre-fix, this query would
    // inherit `status: "READY"` and match zero rows when the buyer's
    // 80 items were all DRAFT.
    expect(buildItemsWhere({ buyId: "1" })).toEqual({
      draftPo: { buyId: 1 },
    });
  });

  it("respects an explicit status alongside a buyId", () => {
    expect(buildItemsWhere({ buyId: "1", status: "DRAFT" })).toEqual({
      draftPo: { buyId: 1 },
      status: "DRAFT",
    });
  });

  it("treats 'unassigned' as draftPo.buyId IS NULL", () => {
    expect(buildItemsWhere({ buyId: "unassigned" })).toEqual({
      draftPo: { buyId: null },
    });
  });
});

describe("buildItemsWhere — vendor scoping", () => {
  it("adds vendorId to the where clause", () => {
    expect(buildItemsWhere({ vendorId: "7" })).toEqual({
      vendorId: 7,
      status: "READY", // bare query default still applies
    });
  });

  it("combines vendorId + buyId without firing the READY default", () => {
    expect(buildItemsWhere({ vendorId: "7", buyId: "1" })).toEqual({
      vendorId: 7,
      draftPo: { buyId: 1 },
    });
  });
});

describe("buildPosWhere", () => {
  it("applies READY default when bare", () => {
    expect(buildPosWhere({})).toEqual({ status: "READY" });
  });

  it("scopes by direct buyId field (not via draftPo relation)", () => {
    expect(buildPosWhere({ buyId: "3" })).toEqual({ buyId: 3 });
  });

  it("treats 'unassigned' as buyId IS NULL", () => {
    expect(buildPosWhere({ buyId: "unassigned" })).toEqual({ buyId: null });
  });

  it("scopes by ids", () => {
    expect(buildPosWhere({ ids: "10,20" })).toEqual({ id: { in: [10, 20] } });
  });
});

describe("buildWorkbookItemsWhere", () => {
  it("returns empty WHERE for bare query — NO READY default ever", () => {
    // The workbook is a review artifact; the buyer wants the whole
    // picture by default, not just the READY batch.
    expect(buildWorkbookItemsWhere({})).toEqual({});
  });

  it("applies buyId scoping the same as items", () => {
    expect(buildWorkbookItemsWhere({ buyId: "1" })).toEqual({
      draftPo: { buyId: 1 },
    });
  });

  it("respects an explicit status filter", () => {
    expect(buildWorkbookItemsWhere({ status: "EXPORTED" })).toEqual({ status: "EXPORTED" });
  });

  it("combines vendor + buy + status", () => {
    expect(buildWorkbookItemsWhere({ vendorId: "9", buyId: "2", status: "FULFILLED" })).toEqual({
      vendorId: 9,
      draftPo: { buyId: 2 },
      status: "FULFILLED",
    });
  });
});
