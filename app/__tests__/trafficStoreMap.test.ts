// /app/__tests__/trafficStoreMap.test.ts
//
// PLACEHOLDER TEST — Grade: A (pure helpers only). The Prisma mock below
// is an isolation shim -- buildTrafficStoreMap is a pure function taking
// literal StoreLocation-shaped rows, so no SQL is exercised in this file.
//
// NOT tested here: getTrafficStoreMap's 60s cache / invalidateTrafficStoreMap
// (those need real timers or a real DB round-trip). That's an integration-test
// concern per the task brief for this change.

jest.mock("@/lib/prisma", () => ({ prisma: {} }));

import { buildTrafficStoreMap, type TrafficSourceStoreLocation } from "@/lib/trafficStoreMap";

describe("buildTrafficStoreMap", () => {
  it("resolves a source name to its owning StoreLocation (case-insensitive)", () => {
    const rows: TrafficSourceStoreLocation[] = [
      { id: 1, name: "Main Showroom", trafficSourceNames: ["Main Showroom"] },
    ];
    const map = buildTrafficStoreMap(rows);
    expect(map.resolveStoreLocation("main showroom")).toEqual({ id: 1, name: "Main Showroom" });
    expect(map.resolveStoreLocation("MAIN SHOWROOM")).toEqual({ id: 1, name: "Main Showroom" });
    expect(map.resolveDisplayName("Main Showroom")).toBe("Main Showroom");
  });

  it("trims whitespace before matching", () => {
    const rows: TrafficSourceStoreLocation[] = [
      { id: 2, name: "West Showroom", trafficSourceNames: ["West Showroom"] },
    ];
    const map = buildTrafficStoreMap(rows);
    expect(map.resolveStoreLocation("  West Showroom  ")).toEqual({
      id: 2,
      name: "West Showroom",
    });
    expect(map.resolveDisplayName("\tWest Showroom\n")).toBe("West Showroom");
  });

  it("maps multiple source names to the same StoreLocation", () => {
    const rows: TrafficSourceStoreLocation[] = [
      {
        id: 3,
        name: "Downtown",
        trafficSourceNames: ["Downtown Building A", "Downtown Building B"],
      },
    ];
    const map = buildTrafficStoreMap(rows);
    expect(map.resolveStoreLocation("Downtown Building A")).toEqual({
      id: 3,
      name: "Downtown",
    });
    expect(map.resolveStoreLocation("Downtown Building B")).toEqual({
      id: 3,
      name: "Downtown",
    });
    expect(map.resolveDisplayName("Downtown Building A")).toBe("Downtown");
    expect(map.resolveDisplayName("Downtown Building B")).toBe("Downtown");
  });

  it("passes through the raw name unchanged for an unmapped source (never drops a row)", () => {
    const rows: TrafficSourceStoreLocation[] = [
      { id: 1, name: "Main Showroom", trafficSourceNames: ["Main Showroom"] },
    ];
    const map = buildTrafficStoreMap(rows);
    expect(map.resolveDisplayName("Brand New Kiosk")).toBe("Brand New Kiosk");
    expect(map.resolveStoreLocation("Brand New Kiosk")).toBeNull();
  });

  it("handles an empty StoreLocation list -- everything passes through unmapped", () => {
    const map = buildTrafficStoreMap([]);
    expect(map.resolveDisplayName("Anything")).toBe("Anything");
    expect(map.resolveStoreLocation("Anything")).toBeNull();
  });

  it("handles a StoreLocation with no trafficSourceNames (not counted anywhere)", () => {
    const rows: TrafficSourceStoreLocation[] = [
      { id: 4, name: "No Counter Store", trafficSourceNames: [] },
    ];
    const map = buildTrafficStoreMap(rows);
    expect(map.resolveStoreLocation("No Counter Store")).toBeNull();
    expect(map.resolveDisplayName("No Counter Store")).toBe("No Counter Store");
  });
});
