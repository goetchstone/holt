// /app/__tests__/billingReadiness.test.ts
//
// Pure tests for the AR/GL readiness summarizer. The DB-backed getBillingReadiness
// is a thin query over this; the contract worth pinning is "which required
// mappings are still missing" given the labels that resolved.

import { summarizeArGlReadiness, REQUIRED_AR_GL_MAPPINGS } from "@/lib/billing/billingReadiness";

describe("summarizeArGlReadiness", () => {
  it("is ready only when every required label is present", () => {
    const all = REQUIRED_AR_GL_MAPPINGS.map((m) => m.label);
    expect(summarizeArGlReadiness(all)).toEqual({ ready: true, missing: [] });
  });

  it("reports the missing labels when none are mapped", () => {
    const { ready, missing } = summarizeArGlReadiness([]);
    expect(ready).toBe(false);
    expect(missing).toEqual(["Accounts Receivable", "Invoice Sales"]);
  });

  it("reports the single missing label when partially mapped", () => {
    const { ready, missing } = summarizeArGlReadiness(["Accounts Receivable"]);
    expect(ready).toBe(false);
    expect(missing).toEqual(["Invoice Sales"]);
  });

  it("ignores unrelated labels", () => {
    const present = ["Accounts Receivable", "Invoice Sales", "Sales Tax", "Cash"];
    expect(summarizeArGlReadiness(present)).toEqual({ ready: true, missing: [] });
  });
});
