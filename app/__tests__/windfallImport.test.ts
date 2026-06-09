// /app/__tests__/windfallImport.test.ts

import { parseWindfallCustomerRow, computeWealthTier } from "../src/lib/windfallImport";

describe("parseWindfallCustomerRow — column-name resilience", () => {
  it("parses the current Windfall format (Cuscode + FirstName/LastName)", () => {
    const row = {
      Company: "Cheshire",
      Cuscode: "CHCT10360",
      FirstName: "Scarlett",
      LastName: "Greenstein",
      Email: "sammyg40@att.net",
      "Net Worth": "2500000",
      "Windfall Id": "WF-123",
      "Match Confidence": "0.95",
      "Boat Owner": "1",
      "Recent Mover": "true",
    };
    const result = parseWindfallCustomerRow(row);
    expect(result).not.toBeNull();
    expect(result?.customerCode).toBe("CHCT10360");
    expect(result?.firstName).toBe("Scarlett");
    expect(result?.lastName).toBe("Greenstein");
    expect(result?.netWorth).toBe(2500000);
    expect(result?.windfallId).toBe("WF-123");
    expect(result?.boatOwner).toBe(true);
    expect(result?.recentMover).toBe(true);
  });

  it("parses the legacy format (Code + first_name/last_name)", () => {
    const row = {
      Code: "SO-12345",
      first_name: "Jane",
      last_name: "Doe",
      "Net Worth": "5000000",
    };
    const result = parseWindfallCustomerRow(row);
    expect(result).not.toBeNull();
    expect(result?.customerCode).toBe("SO-12345");
    expect(result?.firstName).toBe("Jane");
    expect(result?.lastName).toBe("Doe");
  });

  it("returns null when customer code is missing in both formats", () => {
    expect(parseWindfallCustomerRow({ FirstName: "Jane" })).toBeNull();
    expect(parseWindfallCustomerRow({ Code: "" })).toBeNull();
    expect(parseWindfallCustomerRow({ Cuscode: "   " })).toBeNull();
  });

  it("leaves wealth fields as null when blank (matches the sample CSV row)", () => {
    // Cheshire,CHCT10360,... with all wealth columns empty
    const row = {
      Company: "Cheshire",
      Cuscode: "CHCT10360",
      FirstName: "Scarlett",
      LastName: "Greenstein",
      Email: "sammyg40@att.net",
      "Net Worth": "",
      "Net Worth Low": "",
      "Net Worth High": "",
      "Windfall Id": "",
      "Match Confidence": "",
      "Boat Owner": "",
    };
    const result = parseWindfallCustomerRow(row);
    expect(result).not.toBeNull();
    expect(result?.netWorth).toBeNull();
    expect(result?.windfallId).toBeNull();
    expect(result?.matchConfidence).toBeNull();
    expect(result?.boatOwner).toBe(false);
  });
});

describe("computeWealthTier", () => {
  it("classifies net worth into tiers", () => {
    expect(computeWealthTier(15_000_000)).toBe("ULTRA_HIGH");
    expect(computeWealthTier(10_000_000)).toBe("ULTRA_HIGH");
    expect(computeWealthTier(5_000_000)).toBe("VERY_HIGH");
    expect(computeWealthTier(1_500_000)).toBe("HIGH");
    expect(computeWealthTier(1_000_000)).toBe("HIGH");
    expect(computeWealthTier(600_000)).toBe("AFFLUENT");
    expect(computeWealthTier(500_000)).toBe("AFFLUENT");
    expect(computeWealthTier(100_000)).toBeNull();
    expect(computeWealthTier(null)).toBeNull();
  });
});
