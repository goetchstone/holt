// /app/__tests__/protectionPlanCommission.test.ts
//
// The contract the commission screen and the plans endpoint share for a protection-plan
// commission plan (GAP-24, DECISIONS 56): what is checked, and how a setup becomes the
// engine's one rule and back.

import {
  bracketsToTiers,
  formFromSetup,
  setupFromForm,
  parseProtectionPlanSetup,
  ruleShape,
  setupFromRule,
} from "../src/lib/protectionPlanCommission";

const valid = {
  name: "Protection plans",
  categoryId: 4,
  pays: "PERCENT",
  resets: "YEAR",
  alsoCountsInMainPlan: false,
  brackets: [
    { from: 0, amount: 0.1 },
    { from: 5_000, amount: 0.15 },
  ],
};

describe("parseProtectionPlanSetup", () => {
  it("takes a complete setup", () => {
    const parsed = parseProtectionPlanSetup({ ...valid, name: "  PP 10%  ", description: "" });
    expect(parsed).toEqual({
      ok: true,
      setup: {
        name: "PP 10%",
        description: null,
        categoryId: 4,
        pays: "PERCENT",
        resets: "YEAR",
        alsoCountsInMainPlan: false,
        brackets: valid.brackets,
      },
    });
  });

  it.each([
    ["no name", { name: "  " }, "Plan name is required."],
    ["no category", { categoryId: null }, "Choose the category your protection plans are in."],
    ["a category that isn't an id", { categoryId: 2.5 }, "Choose the category"],
    ["an unknown way to pay", { pays: "SPIFF" }, "a percent or an amount per plan"],
    ["an unknown reset", { resets: "WEEK" }, "when the brackets start over"],
    ["the main-plan choice left out", { alsoCountsInMainPlan: undefined }, "also count"],
    ["no rates", { brackets: [] }, "at least one rate"],
    ["a blank start", { brackets: [{ from: null, amount: 0.1 }] }, "where it starts"],
    ["a negative rate", { brackets: [{ from: 0, amount: -0.1 }] }, "0 or more"],
    ["a percent over 100", { brackets: [{ from: 0, amount: 1.5 }] }, "more than 100%"],
    [
      "brackets out of order",
      {
        brackets: [
          { from: 0, amount: 0.1 },
          { from: 0, amount: 0.2 },
        ],
      },
      "has to start above",
    ],
  ])("refuses %s", (_label, patch, message) => {
    const parsed = parseProtectionPlanSetup({ ...valid, ...patch });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });

  it("lets an amount per plan be more than 1", () => {
    const parsed = parseProtectionPlanSetup({
      ...valid,
      pays: "PER_PLAN",
      brackets: [{ from: 0, amount: 25 }],
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("the screen's form", () => {
  it("shows a saved rate as a percent and sends it back as a rate", () => {
    const form = formFromSetup({ ...valid, pays: "PERCENT", resets: "YEAR" });
    expect(form.brackets).toEqual([
      { from: "0", amount: "10" },
      { from: "5000", amount: "15" },
    ]);
    const parsed = parseProtectionPlanSetup(setupFromForm(form));
    expect(parsed.ok && parsed.setup.brackets).toEqual(valid.brackets);
  });

  it("keeps an amount per plan as dollars", () => {
    const form = formFromSetup({
      ...valid,
      pays: "PER_PLAN",
      resets: "YEAR",
      brackets: [{ from: 0, amount: 25 }],
    });
    expect(form.brackets).toEqual([{ from: "0", amount: "25" }]);
    expect(setupFromForm(form).brackets).toEqual([{ from: 0, amount: 25 }]);
  });

  it("a blank field is sent so the server can say what's missing", () => {
    const form = formFromSetup({ ...valid, pays: "PERCENT", resets: "YEAR", categoryId: null });
    const sent = setupFromForm({ ...form, brackets: [{ from: "0", amount: " " }] });
    expect(sent.categoryId).toBeNull();
    const parsed = parseProtectionPlanSetup({ ...sent, categoryId: 4 });
    expect(!parsed.ok && parsed.error).toContain("rate must be 0 or more");
  });
});

describe("a setup as the engine's rule", () => {
  it("each bracket runs to where the next starts; the last has no end", () => {
    expect(bracketsToTiers({ pays: "PERCENT", brackets: valid.brackets })).toEqual([
      {
        label: "From $0",
        minAmount: 0,
        maxAmountExclusive: 5_000,
        rate: 0.1,
        perUnitAmount: null,
        sortOrder: 0,
      },
      {
        label: "From $5,000",
        minAmount: 5_000,
        maxAmountExclusive: null,
        rate: 0.15,
        perUnitAmount: null,
        sortOrder: 1,
      },
    ]);
  });

  it("an amount per plan is per unit, counted in plans", () => {
    const tiers = bracketsToTiers({
      pays: "PER_PLAN",
      brackets: [
        { from: 0, amount: 20 },
        { from: 10, amount: 30 },
      ],
    });
    expect(tiers.map((t) => [t.label, t.rate, t.perUnitAmount])).toEqual([
      ["From the first plan", null, 20],
      ["After 10 plans", null, 30],
    ]);
    expect(ruleShape({ pays: "PER_PLAN", resets: "PAY_PERIOD" })).toEqual({
      basis: "UNITS",
      accumulator: "PERIOD",
    });
    expect(ruleShape({ pays: "PERCENT", resets: "YEAR" })).toEqual({
      basis: "REVENUE",
      accumulator: "YTD",
    });
  });

  it("reads back what was saved", () => {
    for (const pays of ["PERCENT", "PER_PLAN"] as const) {
      const setup = { pays, resets: "PAY_PERIOD" as const, brackets: valid.brackets };
      const rule = { ...ruleShape(setup), tiers: bracketsToTiers(setup) };
      expect(setupFromRule(rule)).toEqual(setup);
    }
  });
});
