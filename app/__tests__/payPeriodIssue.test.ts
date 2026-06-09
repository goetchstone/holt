// /app/__tests__/payPeriodIssue.test.ts
//
// Pure tests for the pay-period issue-flag helpers (open detection,
// latest-open selection, summary for the manager grid).

import {
  isIssueOpen,
  findOpenIssue,
  summarizeOpenIssues,
  type PayPeriodIssueLike,
} from "../src/lib/payPeriodIssue";

function issue(over: Partial<PayPeriodIssueLike>): PayPeriodIssueLike {
  return {
    id: 1,
    staffMemberId: 10,
    note: "numbers look off",
    reportedBy: "designer@example.com",
    reportedAt: new Date("2026-05-18T12:00:00Z"),
    resolvedAt: null,
    ...over,
  };
}

describe("isIssueOpen", () => {
  it("is open when resolvedAt is null", () => {
    expect(isIssueOpen({ resolvedAt: null })).toBe(true);
  });
  it("is closed when resolvedAt is set", () => {
    expect(isIssueOpen({ resolvedAt: new Date("2026-05-20T00:00:00Z") })).toBe(false);
  });
});

describe("findOpenIssue", () => {
  it("returns null when there are no issues", () => {
    expect(findOpenIssue([])).toBeNull();
  });

  it("returns null when every issue is resolved", () => {
    const issues = [
      issue({ id: 1, resolvedAt: new Date("2026-05-19T00:00:00Z") }),
      issue({ id: 2, resolvedAt: new Date("2026-05-20T00:00:00Z") }),
    ];
    expect(findOpenIssue(issues)).toBeNull();
  });

  it("ignores resolved issues and returns the latest OPEN one", () => {
    const issues = [
      issue({ id: 1, resolvedAt: new Date("2026-05-19T00:00:00Z") }), // resolved
      issue({ id: 2, reportedAt: new Date("2026-05-18T09:00:00Z"), note: "older open" }),
      issue({ id: 3, reportedAt: new Date("2026-05-18T15:00:00Z"), note: "newer open" }),
    ];
    const found = findOpenIssue(issues);
    expect(found?.id).toBe(3);
    expect(found?.note).toBe("newer open");
  });
});

describe("summarizeOpenIssues", () => {
  it("reports zero open and null fields when nothing is open", () => {
    const issues = [issue({ id: 1, resolvedAt: new Date("2026-05-19T00:00:00Z") })];
    expect(summarizeOpenIssues(issues)).toEqual({
      openCount: 0,
      note: null,
      reportedBy: null,
      reportedAt: null,
    });
  });

  it("counts open issues and surfaces the latest open note", () => {
    const issues = [
      issue({ id: 1, resolvedAt: new Date("2026-05-19T00:00:00Z") }), // resolved — not counted
      issue({ id: 2, reportedAt: new Date("2026-05-18T09:00:00Z"), note: "first" }),
      issue({
        id: 3,
        reportedAt: new Date("2026-05-18T15:00:00Z"),
        note: "latest",
        reportedBy: "sandy@example.com",
      }),
    ];
    const summary = summarizeOpenIssues(issues);
    expect(summary.openCount).toBe(2);
    expect(summary.note).toBe("latest");
    expect(summary.reportedBy).toBe("sandy@example.com");
    expect(summary.reportedAt).toEqual(new Date("2026-05-18T15:00:00Z"));
  });
});
