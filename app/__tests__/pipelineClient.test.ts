// /app/__tests__/pipelineClient.test.ts
//
// Which customer rows are a real client, and which numbers are worth dialing.

import {
  callablePhone,
  distinctLocations,
  hasPurchased,
  isCashSaleCustomer,
  mailableEmail,
  summarizeQuoteLines,
  topBrands,
} from "@/lib/pipelineClient";

describe("isCashSaleCustomer", () => {
  it("matches the placeholder by name, ignoring case and stray spaces", () => {
    expect(isCashSaleCustomer({ firstName: "Cash", lastName: "Sale" })).toBe(true);
    expect(isCashSaleCustomer({ firstName: " cash ", lastName: "SALE" })).toBe(true);
  });

  it("doesn't match a real person or a missing name", () => {
    expect(isCashSaleCustomer({ firstName: "Jo", lastName: "Cash" })).toBe(false);
    expect(isCashSaleCustomer({ firstName: "Cash", lastName: null })).toBe(false);
    expect(isCashSaleCustomer({ firstName: null, lastName: null })).toBe(false);
  });
});

describe("hasPurchased", () => {
  it("trusts an actual sale over a lifetime count that hasn't refreshed yet", () => {
    expect(hasPurchased({ orderCount: 0, lastPurchase: { id: 1 } })).toBe(true);
    expect(hasPurchased({ orderCount: 3, lastPurchase: null })).toBe(true);
    expect(hasPurchased({ orderCount: 0, lastPurchase: null })).toBe(false);
  });
});

describe("callablePhone", () => {
  it("keeps a real number", () => {
    expect(callablePhone("202-555-0143")).toBe("202-555-0143");
  });

  it("drops blanks", () => {
    expect(callablePhone(null)).toBeNull();
    expect(callablePhone(undefined)).toBeNull();
    expect(callablePhone("   ")).toBeNull();
  });

  it("drops junk numbers found on real customers", () => {
    expect(callablePhone("555")).toBeNull();
    expect(callablePhone("00")).toBeNull();
    expect(callablePhone("000-000-0000")).toBeNull();
    expect(callablePhone("202-555-014")).toBeNull();
  });
});

describe("summarizeQuoteLines", () => {
  const line = (productName: string | null) => ({ productName });

  it("names up to three items and counts the rest", () => {
    const lines = [line("Sofa"), line("Chair"), line("Rug"), line("Lamp")];
    expect(summarizeQuoteLines(lines)).toEqual({
      summary: "Sofa, Chair, Rug +1 more",
      isPlaceholder: false,
    });
  });

  it("says a quote with nothing priced is a placeholder instead of empty", () => {
    expect(summarizeQuoteLines([])).toEqual({
      summary: "Placeholder, nothing priced yet",
      isPlaceholder: true,
    });
  });

  it("counts any priced line as itemized, with or without a part number", () => {
    expect(summarizeQuoteLines([line("Custom Table")]).isPlaceholder).toBe(false);
  });
});

describe("mailableEmail", () => {
  it("keeps a good address and trims around it", () => {
    expect(mailableEmail(" pat@example.com ")).toBe("pat@example.com");
  });

  it("drops typed-in trailing punctuation", () => {
    expect(mailableEmail("pat.lee@example.com,")).toBe("pat.lee@example.com");
    expect(mailableEmail("pat@example.com;.")).toBe("pat@example.com");
  });

  it("leaves out blanks and malformed addresses", () => {
    expect(mailableEmail(null)).toBeNull();
    expect(mailableEmail("  ")).toBeNull();
    expect(mailableEmail("averyrg133@example.;com")).toBeNull();
    expect(mailableEmail("no-at-sign.com")).toBeNull();
  });
});

describe("topBrands", () => {
  const line = (vendorName: string, lineTotal: number) => ({ vendorName, lineTotal });

  it("adds up each brand and puts the biggest first", () => {
    expect(
      topBrands([line("Alder Works", 500), line("Birch Hall", 900), line("Alder Works", 600)]),
    ).toEqual(["Alder Works", "Birch Hall"]);
  });

  it("keeps the top few", () => {
    const lines = ["A", "B", "C", "D", "E"].map((name, i) => line(name, 10 - i));
    expect(topBrands(lines)).toEqual(["A", "B", "C", "D"]);
  });
});

describe("distinctLocations", () => {
  it("lists each town once, ignoring case, in the order they're on file", () => {
    expect(
      distinctLocations([
        { city: "Lakeside", state: "ME" },
        { city: "OLD HARBOR", state: "ME" },
        { city: "lakeside", state: "me" },
      ]),
    ).toEqual(["Lakeside, ME", "OLD HARBOR, ME"]);
  });

  it("skips blank rows and keeps a town with no state", () => {
    expect(
      distinctLocations([
        { city: " ", state: " " },
        { city: "Seaview", state: "" },
      ]),
    ).toEqual(["Seaview"]);
  });
});
