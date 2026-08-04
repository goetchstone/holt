// /app/__tests__/trafficStoreMap.test.ts
//
// PLACEHOLDER TEST — Grade: A (mocked-Prisma wiring only, not SQL behavior)
// buildTrafficStoreMap is a pure function taking literal StoreLocation-shaped
// rows, so most of this file exercises no SQL at all -- the Prisma mock below
// is purely an isolation shim for those cases.
//
// getTrafficStoreMap's 60s cache / invalidateTrafficStoreMap's generation
// counter (the fix for a cache-invalidation race -- see that describe block)
// ARE tested here, with a controllable (deferred-promise) prisma.storeLocation
// .findMany mock standing in for a real DB round-trip. That mock returns
// canned rows -- it verifies none of Prisma's actual query/filter behavior,
// only that getTrafficStoreMap() calls it and reacts to timing correctly.
// The thing actually under test (the generation counter) is pure in-process
// logic, so this stays Grade A despite the Prisma mock: no real timers
// needed either, since the race is about ORDER of completion between two
// in-flight loads, not elapsed wall-clock time -- resolving mocked promises
// in a chosen order is enough to reproduce it deterministically.

jest.mock("@/lib/prisma", () => ({ prisma: { storeLocation: { findMany: jest.fn() } } }));

import { prisma } from "@/lib/prisma";
import {
  buildTrafficStoreMap,
  getTrafficStoreMap,
  invalidateTrafficStoreMap,
  type TrafficSourceStoreLocation,
} from "@/lib/trafficStoreMap";

const findManyMock = prisma.storeLocation.findMany as jest.Mock;

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

// ---------------------------------------------------------------------------
// getTrafficStoreMap / invalidateTrafficStoreMap -- cache invalidation race
// ---------------------------------------------------------------------------

/** A promise plus its resolver, pulled out so a test can control exactly
 *  when a mocked prisma.storeLocation.findMany() call resolves relative to
 *  other calls and to invalidateTrafficStoreMap(). */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("getTrafficStoreMap / invalidateTrafficStoreMap", () => {
  beforeEach(() => {
    // Reset both the cache AND the generation counter to a known state --
    // these are module-level singletons shared across every test in this
    // file, exactly the way they are shared across every request in the
    // real server process.
    invalidateTrafficStoreMap();
    findManyMock.mockReset();
  });

  it("serves the cached resolver on a second call within the TTL, without re-querying", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: 1, name: "Downtown", trafficSourceNames: ["DT"] },
    ]);
    const first = await getTrafficStoreMap();
    const second = await getTrafficStoreMap();
    expect(first).toBe(second); // same cached object, not just equal
    expect(findManyMock).toHaveBeenCalledTimes(1);
  });

  it("rebuilds from StoreLocation after invalidateTrafficStoreMap()", async () => {
    findManyMock.mockResolvedValueOnce([{ id: 1, name: "Downtown", trafficSourceNames: ["DT"] }]);
    await getTrafficStoreMap();

    invalidateTrafficStoreMap();
    findManyMock.mockResolvedValueOnce([{ id: 1, name: "Downtown", trafficSourceNames: ["DT", "DT2"] }]);
    const map = await getTrafficStoreMap();

    expect(findManyMock).toHaveBeenCalledTimes(2);
    expect(map.resolveDisplayName("DT2")).toBe("Downtown");
  });

  it(
    "does not let a load started BEFORE an invalidation re-pin a stale mapping after it resolves " +
      "AFTER a fresher load already cached (the race invalidateTrafficStoreMap's generation counter fixes)",
    async () => {
      // Kick off a load. Its query is still pending -- nothing has resolved
      // yet, so this load is "in flight" exactly like a real request whose
      // DB round-trip hasn't come back.
      const firstQuery = deferred<Array<{ id: number; name: string; trafficSourceNames: string[] }>>();
      findManyMock.mockImplementationOnce(() => firstQuery.promise);
      const firstCall = getTrafficStoreMap();

      // A config-preset apply lands WHILE that load is still in flight: it
      // invalidates the cache, and the NEXT call re-queries for fresh
      // (post-apply) data. This second load resolves immediately and caches
      // its result.
      invalidateTrafficStoreMap();
      findManyMock.mockResolvedValueOnce([
        { id: 1, name: "Downtown", trafficSourceNames: ["DT", "New Door"] },
      ]);
      const freshMap = await getTrafficStoreMap();
      expect(freshMap.resolveDisplayName("New Door")).toBe("Downtown");
      expect(findManyMock).toHaveBeenCalledTimes(2);

      // NOW let the stale first load resolve, with the PRE-apply row set it
      // originally queried for.
      firstQuery.resolve([{ id: 1, name: "Downtown", trafficSourceNames: ["DT"] }]);
      const staleMap = await firstCall;
      // The caller who started that load still gets a self-consistent
      // answer for what it asked...
      expect(staleMap.resolveDisplayName("New Door")).toBe("New Door"); // unmapped, from ITS point of view

      // ...but it must NOT have clobbered the cache when it resolved late.
      // A third call within the TTL should still see the FRESH mapping and
      // must not trigger a third query.
      const thirdMap = await getTrafficStoreMap();
      expect(thirdMap.resolveDisplayName("New Door")).toBe("Downtown");
      expect(findManyMock).toHaveBeenCalledTimes(2);
    },
  );
});
