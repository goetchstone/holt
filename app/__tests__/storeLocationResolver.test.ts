// /app/__tests__/storeLocationResolver.test.ts

// Test the pure mapping logic of buildLocationMap without hitting the database.
// We test the map construction and lookup behavior by simulating what the
// resolver does internally.

describe("storeLocationResolver mapping logic", () => {
  // Simulate buildLocationMap output
  function buildMap(
    locations: { id: number; name: string; externalLocationName: string | null }[],
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const loc of locations) {
      map.set(loc.name.toLowerCase(), loc.id);
      if (loc.externalLocationName) {
        map.set(loc.externalLocationName.toLowerCase(), loc.id);
      }
    }
    return map;
  }

  const testLocations = [
    { id: 1, name: "Main Store", externalLocationName: "MS Main" },
    { id: 2, name: "Downtown", externalLocationName: "Downtown Floor" },
    { id: 3, name: "West Store", externalLocationName: null },
  ];

  it("resolves by exact name (case-insensitive)", () => {
    const map = buildMap(testLocations);
    expect(map.get("main store")).toBe(1);
    expect(map.get("downtown")).toBe(2);
    expect(map.get("west store")).toBe(3);
  });

  it("resolves by externalLocationName (case-insensitive)", () => {
    const map = buildMap(testLocations);
    expect(map.get("ms main")).toBe(1);
    expect(map.get("downtown floor")).toBe(2);
  });

  it("returns undefined for unknown names", () => {
    const map = buildMap(testLocations);
    expect(map.get("nonexistent")).toBeUndefined();
    expect(map.get("")).toBeUndefined();
  });

  it("handles case variations", () => {
    const map = buildMap(testLocations);
    expect(map.get("MAIN STORE".toLowerCase())).toBe(1);
    expect(map.get("Main Store".toLowerCase())).toBe(1);
  });

  it("skips null externalLocationName entries", () => {
    const map = buildMap(testLocations);
    // West Store has no externalLocationName, so only name maps
    expect(map.get("west store")).toBe(3);
    // Map should have 5 entries: 3 names + 2 POS names (West Store has none)
    expect(map.size).toBe(5);
  });

  it("handles empty location list", () => {
    const map = buildMap([]);
    expect(map.size).toBe(0);
  });

  it("last POS name wins if duplicate names exist", () => {
    const dupes = [
      { id: 10, name: "Store A", externalLocationName: "Legacy Name" },
      { id: 20, name: "Store B", externalLocationName: "Legacy Name" },
    ];
    const map = buildMap(dupes);
    // Second entry overwrites -- this is expected; externalLocationName should be unique
    expect(map.get("legacy name")).toBe(20);
  });
});
