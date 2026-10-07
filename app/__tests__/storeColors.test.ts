// /app/__tests__/storeColors.test.ts
//
// Traffic-counter display-name / StoreLocation mapping used to be tested
// here too (getStoreDisplayName), back when it was a hardcoded literal in
// this file. That mapping is now database-backed -- see
// lib/trafficStoreMap.ts and __tests__/trafficStoreMap.test.ts. This file
// stays focused on the one thing storeColors.ts still owns: colors.

import { getStoreColor } from "../src/lib/storeColors";

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
