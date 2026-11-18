// /app/__tests__/countedLineFilter.test.ts
//
// The shared counted-line filter (rule 33) in its three spellings: Prisma, a Prisma.sql
// fragment and text for a query built as a string. All three leave out cancelled and
// replaced lines, so a replaced line and its replacement don't both count. Which totals
// use them is checked in reports.cancelledLineFilter.test.ts; what they do to a real
// total is in integration/replacedLines.integration.test.ts.
//
// Each has an item form that leaves a gift card line out too: a card sold on a sale is
// owed but isn't revenue or goods. Which files may keep the owed form is checked in
// countedLineOwedSites.test.ts.

import fs from "node:fs";
import path from "node:path";

import {
  countedItemLineSql,
  countedItemLineSqlText,
  countedLineSql,
  countedLineSqlText,
} from "@/lib/reports/revenueScope";
import {
  COUNTED_ITEM_LINE,
  COUNTED_LINE_FILTER,
  COUNTED_LINE_STATUSES,
  isCountedItemLine,
  isCountedLine,
} from "@/lib/salesOrderRevenue";

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
      expect(() => countedItemLineSql(alias)).toThrow("unsafe table alias");
      expect(() => countedItemLineSqlText(alias)).toThrow("unsafe table alias");
    },
  );
});

describe("the counted item line: a gift card line out too", () => {
  it("is the same status filter, plus no gift card, as a positive IS NULL (rule 51)", () => {
    expect(COUNTED_ITEM_LINE).toEqual({
      lineItemStatus: { in: ["ACTIVE", "BACKORDERED"] },
      giftCardNumber: null,
    });
  });

  it("keeps an item line and leaves out a card line, a cancelled line and a replaced one", () => {
    expect(isCountedItemLine({ lineItemStatus: "ACTIVE", giftCardNumber: null })).toBe(true);
    expect(isCountedItemLine({ lineItemStatus: "BACKORDERED" })).toBe(true);
    expect(isCountedItemLine({ lineItemStatus: "ACTIVE", giftCardNumber: "GC-1001" })).toBe(false);
    expect(isCountedItemLine({ lineItemStatus: "CANCELLED", giftCardNumber: null })).toBe(false);
    expect(isCountedItemLine({ lineItemStatus: "REPLACED" })).toBe(false);
    // The owed form keeps the card line in: the customer pays for it.
    expect(isCountedLine("ACTIVE")).toBe(true);
  });

  it("reads a null status as the column's default, ACTIVE", () => {
    expect(isCountedItemLine({ lineItemStatus: null })).toBe(true);
    expect(isCountedItemLine({ lineItemStatus: null, giftCardNumber: "GC-1001" })).toBe(false);
  });

  it("adds the card test to the Prisma.sql fragment, as one parenthesised predicate", () => {
    const fragment = countedItemLineSql("li");
    expect(fragment.sql).toBe(
      '("li"."lineItemStatus"::text IN (?,?) AND "li"."giftCardNumber" IS NULL)',
    );
    expect(fragment.values).toEqual(["ACTIVE", "BACKORDERED"]);
  });

  it("spells the same out for a query built as text", () => {
    expect(countedItemLineSqlText("li_por")).toBe(
      `("li_por"."lineItemStatus"::text IN ('ACTIVE', 'BACKORDERED') AND "li_por"."giftCardNumber" IS NULL)`,
    );
  });
});

// Rule 33's text is guidance every session reads. It once printed `{ not: "CANCELLED" }`, and
// 43 files copied it, counting a replaced line twice (#112). So the rule and the guidance
// that repeats it name the shared filter, and the names they give must still be exports.
describe("rule 33 names the shared filter, not a literal", () => {
  const REPO = path.join(__dirname, "..", "..");
  const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");
  const OLD_FILTER = /lineItemStatus:\s*\{\s*not:\s*["']CANCELLED["']\s*\}/;

  function ruleText(n: number): string {
    const claude = read("CLAUDE.md");
    const start = claude.search(new RegExp(`^${n}\\. \\*\\*`, "m"));
    const afterFirstLine = claude.indexOf("\n", start) + 1;
    const rest = claude.slice(afterFirstLine);
    const next = rest.search(/^\d+\. \*\*|^#/m);
    return claude.slice(start, afterFirstLine + (next === -1 ? rest.length : next));
  }

  it("CLAUDE.md rule 33 names each spelling of the filter, and each is a real export", () => {
    const rule = ruleText(33);
    const named: Record<string, unknown> = {
      COUNTED_ITEM_LINE,
      COUNTED_LINE_FILTER,
      countedItemLineSql,
      countedLineSql,
    };
    for (const [name, value] of Object.entries(named)) {
      expect(rule).toContain(name);
      expect(value).toBeDefined();
    }
  });

  it("no rule, skill or runbook prescribes the old filter", () => {
    const skills = fs
      .readdirSync(path.join(REPO, ".claude", "skills"))
      .map((dir) => `.claude/skills/${dir}/SKILL.md`)
      .filter((rel) => fs.existsSync(path.join(REPO, rel)));
    const runbooks = fs
      .readdirSync(path.join(REPO, "docs", "domains"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => `docs/domains/${f}`);
    const offenders = ["CLAUDE.md", ...skills, ...runbooks].filter((rel) =>
      OLD_FILTER.test(read(rel)),
    );
    expect(offenders).toEqual([]);
  });
});
