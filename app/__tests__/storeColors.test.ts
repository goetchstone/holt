// /app/__tests__/storeColors.test.ts

import { getStoreDisplayName, getStoreColor } from "../src/lib/storeColors";

describe("getStoreDisplayName", () => {
  it("maps a configured counter name to its display label", () => {
    expect(getStoreDisplayName("Main Showroom")).toBe("Main Showroom");
    expect(getStoreDisplayName("West Showroom")).toBe("West Showroom");
  });

  it("returns raw name for unmapped stores", () => {
    expect(getStoreDisplayName("New Location")).toBe("New Location");
  });
});

describe("getStoreColor", () => {
  it("returns solid colors by default", () => {
    const color = getStoreColor(0);
    expect(color).toBe("#1e40af");
  });

  it("returns light variant when requested", () => {
    const color = getStoreColor(0, "light");
    expect(color).toBe("#93c5fd");
  });

  it("wraps around the palette for large indices", () => {
    const color0 = getStoreColor(0);
    const color8 = getStoreColor(8);
    expect(color0).toBe(color8);
  });

  it("returns different colors for different indices", () => {
    const colors = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((i) => getStoreColor(i)));
    expect(colors.size).toBe(8);
  });
});
