// /app/__tests__/scheduledSales.test.ts
//
// GAP-06 part B: the pure halves of a scheduled sale -- what a product sells for
// given its sale (lib/pricing/salePrice.ts), where a sale stands on a day and what
// may change then, how a selection is priced, and what a request may say
// (lib/pricing/salesShared.ts), and what a sale tag prints (lib/labels/productTag.ts).
// The database halves are in integration/scheduledSales.integration.test.ts.

import { effectiveRetail, retailResponseFields, saleCoversDay } from "@/lib/pricing/salePrice";
import {
  deleteProblem,
  endEarlyProblem,
  parseSaleFields,
  parseSaleItems,
  parseSalePatch,
  parseSalePricing,
  planSalePrice,
  saleChangeProblem,
  saleDatesProblem,
  saleStatus,
} from "@/lib/pricing/salesShared";
import { saleEndsText, saleTagFields } from "@/lib/labels/productTag";

const SALE = { salePrice: 799.99, endsOn: "2026-11-30" };

describe("effectiveRetail", () => {
  it("is the sale price, with the regular one beside it, while a sale covers today", () => {
    expect(effectiveRetail({ baseRetail: "1000.00", sale: SALE })).toEqual({
      price: 799.99,
      regularPrice: 1000,
      onSale: true,
      saleEndsOn: "2026-11-30",
    });
  });

  it("is the regular price with no sale", () => {
    expect(effectiveRetail({ baseRetail: 1000, sale: null })).toEqual({
      price: 1000,
      regularPrice: 1000,
      onSale: false,
      saleEndsOn: null,
    });
  });

  it("never charges more on sale than off it: a sale price at or above the regular is ignored", () => {
    expect(effectiveRetail({ baseRetail: 799.99, sale: SALE }).onSale).toBe(false);
    expect(effectiveRetail({ baseRetail: 700, sale: SALE })).toMatchObject({
      price: 700,
      onSale: false,
    });
  });

  it("gives no price to a product with none, sale or not (0 is no price)", () => {
    expect(effectiveRetail({ baseRetail: 0, sale: SALE })).toMatchObject({
      price: null,
      onSale: false,
    });
    expect(effectiveRetail({ baseRetail: null, sale: null }).price).toBeNull();
  });

  it("answers the screens' fields: baseRetail is today's price, regularRetail the other", () => {
    expect(retailResponseFields(effectiveRetail({ baseRetail: 1000, sale: SALE }))).toEqual({
      baseRetail: 799.99,
      regularRetail: 1000,
      onSale: true,
      saleEndsOn: "2026-11-30",
    });
    expect(retailResponseFields(effectiveRetail({ baseRetail: 0, sale: null })).baseRetail).toBe(
      undefined,
    );
  });
});

describe("saleCoversDay", () => {
  const sale = { startsOn: "2026-11-20", endsOn: "2026-11-22", endedEarlyAt: null };
  it("covers its first and last day and the days between", () => {
    expect(saleCoversDay(sale, "2026-11-19")).toBe(false);
    expect(saleCoversDay(sale, "2026-11-20")).toBe(true);
    expect(saleCoversDay(sale, "2026-11-22")).toBe(true);
    expect(saleCoversDay(sale, "2026-11-23")).toBe(false);
  });
  it("covers nothing once ended early", () => {
    expect(saleCoversDay({ ...sale, endedEarlyAt: new Date() }, "2026-11-21")).toBe(false);
  });
  it("reads DATE columns as days", () => {
    const fromDb = {
      startsOn: new Date("2026-11-20T00:00:00.000Z"),
      endsOn: new Date("2026-11-22T00:00:00.000Z"),
      endedEarlyAt: null,
    };
    expect(saleCoversDay(fromDb, "2026-11-22")).toBe(true);
  });
});

describe("saleStatus and what may change", () => {
  const sale = { startsOn: "2026-11-20", endsOn: "2026-11-22", endedEarlyAt: null };
  it("is upcoming before its first day, on through its last, ended after", () => {
    expect(saleStatus(sale, "2026-11-19")).toBe("UPCOMING");
    expect(saleStatus(sale, "2026-11-20")).toBe("ON");
    expect(saleStatus(sale, "2026-11-22")).toBe("ON");
    expect(saleStatus(sale, "2026-11-23")).toBe("ENDED");
    expect(saleStatus({ ...sale, endedEarlyAt: "2026-11-21T15:00:00Z" }, "2026-11-21")).toBe(
      "ENDED",
    );
  });

  it("changes dates and products only before it starts; name and note any time", () => {
    expect(saleChangeProblem("UPCOMING", { items: [] })).toBeNull();
    expect(saleChangeProblem("ON", { items: [] })).toMatch(/started.*End it early/);
    expect(saleChangeProblem("ON", { startsOn: "2026-11-25", endsOn: "2026-11-26" })).toMatch(
      /started/,
    );
    expect(saleChangeProblem("ENDED", { items: [] })).toMatch(/ended/);
    expect(saleChangeProblem("ON", { name: "Renamed", note: null })).toBeNull();
    expect(saleChangeProblem("ENDED", { name: "Renamed" })).toBeNull();
  });

  it("ends early only a sale that is on, and deletes only one that hasn't started", () => {
    expect(endEarlyProblem("ON")).toBeNull();
    expect(endEarlyProblem("UPCOMING")).toMatch(/hasn't started/);
    expect(endEarlyProblem("ENDED")).toMatch(/already ended/);
    expect(deleteProblem("UPCOMING")).toBeNull();
    expect(deleteProblem("ON")).toMatch(/hasn't started/);
    expect(deleteProblem("ENDED")).toMatch(/hasn't started/);
  });
});

describe("planSalePrice", () => {
  it("takes a percent off, rounded by the run's rule, else the store's", () => {
    expect(planSalePrice(1000, { kind: "PERCENT_OFF", percent: 15 }, "CENTS")).toEqual({
      salePrice: 850,
      skipped: null,
    });
    expect(
      planSalePrice(1000, { kind: "PERCENT_OFF", percent: 15, rounding: "END_99" }, "CENTS"),
    ).toEqual({ salePrice: 849.99, skipped: null });
    expect(planSalePrice(1000, { kind: "PERCENT_OFF", percent: 15 }, "END_95").salePrice).toBe(
      849.95,
    );
  });

  it("leaves a typed amount as typed", () => {
    expect(planSalePrice(1000, { kind: "AMOUNT", amount: 777.77 }, "END_99")).toEqual({
      salePrice: 777.77,
      skipped: null,
    });
  });

  it("skips no regular price, a price not below it, and one rounded to nothing", () => {
    expect(planSalePrice(null, { kind: "AMOUNT", amount: 5 }, "CENTS").skipped).toBe("NO_RETAIL");
    expect(planSalePrice(0, { kind: "AMOUNT", amount: 5 }, "CENTS").skipped).toBe("NO_RETAIL");
    expect(planSalePrice(100, { kind: "AMOUNT", amount: 100 }, "CENTS").skipped).toBe(
      "NOT_BELOW_REGULAR",
    );
    // 0.1% off $100 rounds up to the whole dollar: no saving.
    expect(
      planSalePrice(100, { kind: "PERCENT_OFF", percent: 0.1, rounding: "WHOLE_UP" }, "CENTS")
        .skipped,
    ).toBe("NOT_BELOW_REGULAR");
    expect(
      planSalePrice(0.8, { kind: "PERCENT_OFF", percent: 50, rounding: "WHOLE_NEAREST" }, "CENTS")
        .skipped,
    ).toBe("ROUNDS_TO_ZERO");
  });
});

describe("what a request may say", () => {
  const today = "2026-11-14";

  it("needs a name and dates from today on, last on or after first", () => {
    expect(
      parseSaleFields({ name: " Fall ", startsOn: today, endsOn: today, note: " " }, today),
    ).toEqual({
      ok: true,
      value: { name: "Fall", startsOn: today, endsOn: today, note: null },
    });
    expect(parseSaleFields({ name: "", startsOn: today, endsOn: today }, today).ok).toBe(false);
    expect(saleDatesProblem("2026-11-13", "2026-11-20", today)).toMatch(/before today/);
    expect(saleDatesProblem("2026-11-20", "2026-11-19", today)).toMatch(/last day/);
    expect(saleDatesProblem("2026-02-30", "2026-03-01", today)).toMatch(/startsOn/);
  });

  it("takes items once each, priced above zero and to the cent", () => {
    expect(parseSaleItems([{ productId: 1, salePrice: 9.99 }])).toEqual({
      ok: true,
      value: [{ productId: 1, salePrice: 9.99 }],
    });
    expect(parseSaleItems(undefined)).toEqual({ ok: true, value: [] });
    expect(
      parseSaleItems([
        { productId: 1, salePrice: 9 },
        { productId: 1, salePrice: 8 },
      ]).ok,
    ).toBe(false);
    expect(parseSaleItems([{ productId: 1, salePrice: 0 }]).ok).toBe(false);
    expect(parseSaleItems([{ productId: 1, salePrice: 9.999 }]).ok).toBe(false);
    expect(parseSaleItems([{ productId: "1", salePrice: 9 }]).ok).toBe(false);
  });

  it("changes dates only as a pair, and refuses a change of nothing", () => {
    expect(parseSalePatch({ startsOn: "2026-11-20" }).ok).toBe(false);
    expect(parseSalePatch({}).ok).toBe(false);
    expect(parseSalePatch({ note: null })).toEqual({ ok: true, value: { note: null } });
  });

  it("prices by a percent between 0 and 100, or an amount to the cent", () => {
    expect(parseSalePricing({ kind: "PERCENT_OFF", percent: 20, rounding: "END_99" }).ok).toBe(
      true,
    );
    expect(parseSalePricing({ kind: "PERCENT_OFF", percent: 100 }).ok).toBe(false);
    expect(parseSalePricing({ kind: "PERCENT_OFF", percent: 20, rounding: "NICE" }).ok).toBe(false);
    expect(parseSalePricing({ kind: "AMOUNT", amount: 10.001 }).ok).toBe(false);
    expect(parseSalePricing({ kind: "MARKUP" }).ok).toBe(false);
  });
});

describe("the sale tag", () => {
  it("prints the regular price as the was price, and the last day, during a sale", () => {
    const price = effectiveRetail({
      baseRetail: 1000,
      sale: { salePrice: 800, endsOn: "2026-11-30" },
    });
    // The product's own was price is a markdown's, not the sale's.
    expect(saleTagFields(price, 1200, "en-US")).toEqual({
      wasPrice: "1000.00",
      saving: "200.00",
      savingPercent: "20",
      saleEnds: "Nov 30, 2026",
    });
  });

  it("is the product's markdown with no sale on, and says what's missing", () => {
    const price = effectiveRetail({ baseRetail: 900, sale: null });
    expect(saleTagFields(price, 1200, "en-US")).toEqual({
      wasPrice: "1200.00",
      saving: "300.00",
      savingPercent: "25",
      saleEnds: "",
    });
    expect(saleTagFields(price, null, "en-US")).toEqual({
      problem: "Set this product's was price before printing a sale tag.",
    });
  });

  it("writes the last day in the store's locale, on the day itself", () => {
    expect(saleEndsText("2026-01-01", "en-US")).toBe("Jan 1, 2026");
    expect(saleEndsText("2026-01-01", "en-GB")).toBe("1 Jan 2026");
    expect(saleEndsText(null, "en-US")).toBe("");
  });
});
