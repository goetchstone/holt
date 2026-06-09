// /app/__tests__/salesBySalesperson.helpers.test.ts
//
// A-grade pure-helper tests for the shared lib that backs the
// salesperson reports. Asserts:
//   - cancelled-line filter always present (CLAUDE.md rule 33)
//   - NULL-safe handling of nullable columns (productName,
//     lineItemStatus) per the failure-log entry 2026-05-05 — Postgres
//     three-valued logic excludes UNKNOWN rows, so naive NOT-OR-equals
//     drops every NULL-valued row silently
//   - delivery + freight excluded by default; toggle includes them
//   - the exclusion matches productName by case-insensitive EQUALS
//     against the 5 canonical the POS names (no partNo match, no
//     contains-substring) — see post-failure log 2026-05-01
//   - false-positive guard: lines with productName containing
//     "delivery" / "freight" as substrings (Susan Roberts SO-38708,
//     "Delivery to 8 Monticello Dr East Lyme") are NOT excluded
//   - applySalesPersonFilter matches by both id and name (the FK-NULL
//     fix from PR #162)

import type { Prisma } from "@prisma/client";
import {
  applySalesPersonFilter,
  buildLineItemWhere,
  staffMemberFilter,
} from "../src/lib/salesBySalesperson";

describe("buildLineItemWhere", () => {
  it("always excludes CANCELLED line items (rule 33)", () => {
    // The 67K legacy rows with NULL lineItemStatus are backfilled to
    // ACTIVE in the 20260505_backfill_lineitem_status_nulls migration,
    // so the schema's @default(ACTIVE) and the data agree. No NULL
    // trap remains for this column.
    const where = buildLineItemWhere([]);
    expect(where.lineItemStatus).toEqual({ not: "CANCELLED" });
  });

  it("keeps the cancelled-line filter even when includeDeliveryFreight is true", () => {
    // Cancelled-line guard is unconditional. Only delivery + freight
    // are toggleable.
    const where = buildLineItemWhere([], true);
    expect(where.lineItemStatus).toEqual({ not: "CANCELLED" });
  });

  it("default: excludes delivery + freight via OR(null, NOT(OR(equals)) (NULL-safe, case-insensitive)", () => {
    // Verified against the 2026-05-01 prod backup: the POS uses these
    // five exact strings for delivery / freight pass-through lines.
    // Structure is AND-of-OR(null, NOT(OR(equals))) so NULL productNames
    // short-circuit at the outer OR's first arm and never hit the
    // NOT-OR three-valued-logic trap.
    //
    // History: an earlier version (PR #204, reverted within an hour)
    // tried `not: { equals: 'X', mode: 'insensitive' }` which Prisma
    // rejects on nullable string fields with
    // "Unknown argument `mode`. Did you mean `lte`?" — every salesperson
    // report errored in prod until this hotfix landed.
    const where = buildLineItemWhere([]);
    expect(where.AND).toEqual([
      {
        OR: [
          { productName: null },
          {
            NOT: {
              OR: [
                { productName: { equals: "Delivery Charge", mode: "insensitive" } },
                { productName: { equals: "Freight", mode: "insensitive" } },
                { productName: { equals: "HD Freight", mode: "insensitive" } },
                { productName: { equals: "Freight - Hunter Douglas", mode: "insensitive" } },
                { productName: { equals: "Hunter Douglas Freight", mode: "insensitive" } },
              ],
            },
          },
        ],
      },
    ]);
  });

  it("explicitly OR-includes NULL productName so the three-valued-logic NULL trap can't drop real product lines", () => {
    // Tripwire test: this is the exact bug shape that produced the
    // 2026-05-05 Julia Filippone SO-1660 outage. If a future refactor
    // collapses back to `where.NOT = { OR: [equals 'A', equals 'B'] }`,
    // this assertion fails first.
    const where = buildLineItemWhere([]);
    const andClauses = where.AND;
    if (!Array.isArray(andClauses)) {
      throw new Error("Expected AND to be an array — schema regressed to NOT-OR form?");
    }
    const firstAnd = andClauses[0];
    const innerOr = (firstAnd as { OR?: Prisma.OrderLineItemWhereInput[] }).OR;
    expect(innerOr).toBeDefined();
    const hasNullArm = innerOr!.some(
      (clause) =>
        "productName" in clause && (clause as { productName: unknown }).productName === null,
    );
    expect(hasNullArm).toBe(true);
  });

  it("includeDeliveryFreight=true drops the AND clause entirely (only cancelled-line guard remains)", () => {
    const where = buildLineItemWhere([], true);
    expect(where.AND).toBeUndefined();
  });

  it("does NOT use the legacy where.NOT structure (the pre-2026-05-05 NULL-trapping form)", () => {
    // Tripwire: any future PR that goes back to `where.NOT = { OR: ... }`
    // re-introduces the 2026-05-05 NULL-trap bug. Block at test time.
    const where = buildLineItemWhere([]);
    expect(where.NOT).toBeUndefined();
  });

  it("does NOT match by partNo (the prior contains-on-partNo behavior is gone)", () => {
    // partNo is no longer in the exclusion. Real products with a partNo
    // like "10080018" but a productName mentioning delivery (because
    // the salesperson typed a courtesy note there) used to be wrongly
    // excluded; not anymore.
    const where = buildLineItemWhere([]);
    const serialized = JSON.stringify(where);
    expect(serialized).not.toMatch(/"partNo"/);
  });

  it("does NOT use contains-substring matching (the prior false-positive root)", () => {
    // The pre-2026-05-01 filter used `contains: "delivery"` /
    // `contains: "freight"` which matched any productName with that
    // substring. That excluded real products like CASP-91510.29
    // ("Cards Special Delivery Baby Shower"), AL-EARLYBIRD ("Early
    // Bird Delivery Request Quick Ship"), and Susan Roberts'
    // 100216574 ("Delivery to 8 Monticello Dr East Lyme") — 40 lines
    // / $36K of real April sales mis-excluded. Switch to `equals`.
    const where = buildLineItemWhere([]);
    const serialized = JSON.stringify(where);
    expect(serialized).not.toMatch(/"contains"/);
  });

  it("does NOT exclude labor lines (designers get credit for labor)", () => {
    // The exclusion list targets only the 5 canonical productNames.
    // None of them are labor codes.
    const where = buildLineItemWhere([]);
    const serialized = JSON.stringify(where).toLowerCase();
    expect(serialized).not.toMatch(/"labor"/);
  });

  it("layers a department filter when departmentNames is non-empty", () => {
    const where = buildLineItemWhere(["Furniture", "Rugs"]);
    expect(where.product).toEqual({
      department: { name: { in: ["Furniture", "Rugs"] } },
    });
  });

  it("omits the department filter when departmentNames is empty", () => {
    const where = buildLineItemWhere([]);
    expect(where.product).toBeUndefined();
  });

  it("composes department filter with includeDeliveryFreight=true (cancelled-only mode)", () => {
    const where = buildLineItemWhere(["Furniture"], true);
    expect(where.lineItemStatus).toEqual({ not: "CANCELLED" });
    expect(where.AND).toBeUndefined();
    expect(where.product).toEqual({
      department: { name: { in: ["Furniture"] } },
    });
  });
});

describe("applySalesPersonFilter", () => {
  // The fix for the 2026-04-29 reconciliation bug. the POS imports
  // populate `salesperson` (string) but leave `salesPersonId` NULL on
  // ~98% of orders. The filter must match BOTH so the report sees
  // the same orders Monthly Performance + Designer Dashboard see.

  it("is a no-op when both ids and names are empty", () => {
    const where: Prisma.SalesOrderWhereInput = { status: "ORDER" };
    applySalesPersonFilter(where, { ids: [], names: [] });
    expect(where).toEqual({ status: "ORDER" });
    expect(where.OR).toBeUndefined();
  });

  it("matches orders by salesPersonId AND splitWithId when ids are present", () => {
    const where: Prisma.SalesOrderWhereInput = {};
    applySalesPersonFilter(where, { ids: [3], names: [] });
    expect(where.OR).toEqual([{ salesPersonId: { in: [3] } }, { splitWithId: { in: [3] } }]);
  });

  it("matches orders by salesperson name string (case-insensitive)", () => {
    const where: Prisma.SalesOrderWhereInput = {};
    applySalesPersonFilter(where, { ids: [], names: ["Cheryl Homan"] });
    expect(where.OR).toEqual([{ salesperson: { equals: "Cheryl Homan", mode: "insensitive" } }]);
  });

  it("layers id-match AND name-match together (the canonical use)", () => {
    const where: Prisma.SalesOrderWhereInput = {};
    applySalesPersonFilter(where, { ids: [3], names: ["Cheryl Homan"] });
    expect(where.OR).toEqual([
      { salesPersonId: { in: [3] } },
      { splitWithId: { in: [3] } },
      { salesperson: { equals: "Cheryl Homan", mode: "insensitive" } },
    ]);
  });

  it("emits one OR clause per name (Prisma `in` is case-sensitive on strings)", () => {
    const where: Prisma.SalesOrderWhereInput = {};
    applySalesPersonFilter(where, { ids: [], names: ["Cheryl Homan", "Sarah Smith"] });
    expect(where.OR).toEqual([
      { salesperson: { equals: "Cheryl Homan", mode: "insensitive" } },
      { salesperson: { equals: "Sarah Smith", mode: "insensitive" } },
    ]);
  });
});

describe("staffMemberFilter", () => {
  // Issue #274 / ROADMAP Short-Term #12. Sandy's StaffMember row has
  // displayName='Sandy' but every imported SalesOrder for her carries
  // salesperson='Sandra Matheny'. Without aliases, a dashboard query
  // for "Sandy" finds zero of her 15 orders.

  it("returns empty filter when staff is null/undefined", () => {
    expect(staffMemberFilter(null)).toEqual({ ids: [], names: [] });
    expect(staffMemberFilter(undefined)).toEqual({ ids: [], names: [] });
  });

  it("includes displayName when no aliases set (back-compat)", () => {
    const result = staffMemberFilter({ id: 5, displayName: "Cheryl Homan" });
    expect(result).toEqual({ ids: [5], names: ["Cheryl Homan"] });
  });

  it("expands aliases into the names list (the Sandy case)", () => {
    const result = staffMemberFilter({
      id: 30,
      displayName: "Sandy",
      aliases: ["Sandra Matheny"],
    });
    expect(result).toEqual({
      ids: [30],
      names: ["Sandy", "Sandra Matheny"],
    });
  });

  it("handles multiple aliases (e.g. married-name + nickname)", () => {
    const result = staffMemberFilter({
      id: 7,
      displayName: "Mary Smith",
      aliases: ["Mary Johnson", "M. Smith"],
    });
    expect(result.ids).toEqual([7]);
    expect(result.names).toEqual(["Mary Smith", "Mary Johnson", "M. Smith"]);
  });

  it("treats empty aliases array same as missing", () => {
    const result = staffMemberFilter({ id: 1, displayName: "Solo", aliases: [] });
    expect(result).toEqual({ ids: [1], names: ["Solo"] });
  });

  it("output composes cleanly with applySalesPersonFilter", () => {
    const where: Prisma.SalesOrderWhereInput = {};
    applySalesPersonFilter(
      where,
      staffMemberFilter({ id: 30, displayName: "Sandy", aliases: ["Sandra Matheny"] }),
    );
    expect(where.OR).toEqual([
      { salesPersonId: { in: [30] } },
      { splitWithId: { in: [30] } },
      { salesperson: { equals: "Sandy", mode: "insensitive" } },
      { salesperson: { equals: "Sandra Matheny", mode: "insensitive" } },
    ]);
  });
});
