// /app/__tests__/countedLineFilter.test.ts
//
// The shared counted-line filter (rule 33) in its three spellings: Prisma, a Prisma.sql
// fragment and text for a query built as a string. All three leave out cancelled and
// replaced lines, so a replaced line and its replacement don't both count. Which totals
// use them is checked in reports.cancelledLineFilter.test.ts; what they do to a real
// total is in integration/replacedLines.integration.test.ts.

import { countedLineSql, countedLineSqlText } from "@/lib/reports/revenueScope";
import { COUNTED_LINE_FILTER, COUNTED_LINE_STATUSES } from "@/lib/salesOrderRevenue";

describe("the counted-line filter", () => {
  it("keeps active and backordered lines, and nothing else", () => {
    expect([...COUNTED_LINE_STATUSES]).toEqual(["ACTIVE", "BACKORDERED"]);
    expect(COUNTED_LINE_FILTER).toEqual({ in: ["ACTIVE", "BACKORDERED"] });
  });

  it("binds the statuses as parameters in a Prisma.sql fragment", () => {
    const fragment = countedLineSql("li");
    expect(fragment.sql).toBe('"li"."lineItemStatus"::text IN (?,?)');
    expect(fragment.values).toEqual(["ACTIVE", "BACKORDERED"]);
  });

  it("spells the same statuses out for a query built as text", () => {
    expect(countedLineSqlText("li_direct")).toBe(
      `"li_direct"."lineItemStatus"::text IN ('ACTIVE', 'BACKORDERED')`,
    );
  });

  it.each(["li; DROP TABLE x", 'li"', "1li", "a_very_long_alias_name"])(
    "refuses %j as an alias, which reaches the query unbound",
    (alias) => {
      expect(() => countedLineSql(alias)).toThrow("unsafe table alias");
      expect(() => countedLineSqlText(alias)).toThrow("unsafe table alias");
    },
  );
});
