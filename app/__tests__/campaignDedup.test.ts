// /app/__tests__/campaignDedup.test.ts

import {
  filterOutRecentlySent,
  buildDaysSinceLastSentMap,
  type RecentTarget,
} from "@/lib/campaignDedup";

const NOW = new Date("2026-06-15T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60 * 1000);

describe("filterOutRecentlySent", () => {
  it("returns all candidates when there is no send log", () => {
    const out = filterOutRecentlySent([1, 2, 3], [], 30, NOW);
    expect(out).toEqual([1, 2, 3]);
  });

  it("excludes customers with a send inside the window", () => {
    const recent: RecentTarget[] = [
      { customerId: 2, sentAt: daysAgo(5) },
      { customerId: 3, sentAt: daysAgo(10) },
    ];
    expect(filterOutRecentlySent([1, 2, 3, 4], recent, 30, NOW)).toEqual([1, 4]);
  });

  it("keeps customers whose only send is older than the window", () => {
    const recent: RecentTarget[] = [{ customerId: 2, sentAt: daysAgo(45) }];
    expect(filterOutRecentlySent([1, 2, 3], recent, 30, NOW)).toEqual([1, 2, 3]);
  });

  it("treats the window boundary inclusively (sent exactly N days ago is still blocked)", () => {
    const recent: RecentTarget[] = [{ customerId: 2, sentAt: daysAgo(30) }];
    expect(filterOutRecentlySent([1, 2], recent, 30, NOW)).toEqual([1]);
  });

  it("picks the most recent send per customer (ignores older duplicates)", () => {
    const recent: RecentTarget[] = [
      { customerId: 2, sentAt: daysAgo(60) },
      { customerId: 2, sentAt: daysAgo(5) },
    ];
    expect(filterOutRecentlySent([1, 2], recent, 30, NOW)).toEqual([1]);
  });

  it("returns empty when every candidate was recently sent", () => {
    const recent: RecentTarget[] = [
      { customerId: 1, sentAt: daysAgo(1) },
      { customerId: 2, sentAt: daysAgo(2) },
    ];
    expect(filterOutRecentlySent([1, 2], recent, 30, NOW)).toEqual([]);
  });
});

describe("buildDaysSinceLastSentMap", () => {
  it("returns an empty map when the log is empty", () => {
    expect(buildDaysSinceLastSentMap([], NOW).size).toBe(0);
  });

  it("returns the age in whole days per customer", () => {
    const recent: RecentTarget[] = [
      { customerId: 1, sentAt: daysAgo(3) },
      { customerId: 2, sentAt: daysAgo(0) },
    ];
    const map = buildDaysSinceLastSentMap(recent, NOW);
    expect(map.get(1)).toBe(3);
    expect(map.get(2)).toBe(0);
  });

  it("uses the most recent send when a customer has multiple entries", () => {
    const recent: RecentTarget[] = [
      { customerId: 1, sentAt: daysAgo(60) },
      { customerId: 1, sentAt: daysAgo(5) },
      { customerId: 1, sentAt: daysAgo(200) },
    ];
    expect(buildDaysSinceLastSentMap(recent, NOW).get(1)).toBe(5);
  });
});
