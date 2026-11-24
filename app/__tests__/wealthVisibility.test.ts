// /app/__tests__/wealthVisibility.test.ts
//
// "See wealth data" (customer.wealth) is answered like "View cost": a route must
// ask for the key on its gate before it can answer it, and the answer is the
// gate's own. The gates refuse an { also } key the catalog does not define, so
// WITH_WEALTH loading on a real gate also proves the key exists.

import { canViewWealth, VIEW_WEALTH, WITH_WEALTH } from "@/lib/auth/wealthVisibility";
import { VIEW_COST } from "@/lib/auth/costVisibility";
import { requirePermission } from "@/lib/auth/requireAuth";
import { permissionProcedure } from "@/server/trpc/trpc";

const noop = async () => {};

describe("canViewWealth", () => {
  it("answers from the gate's holds", () => {
    expect(canViewWealth({ holds: { [VIEW_WEALTH]: true } })).toBe(true);
    expect(canViewWealth({ holds: { [VIEW_WEALTH]: false } })).toBe(false);
  });

  it("throws when the gate never asked, rather than stripping wealth from holders too", () => {
    expect(() => canViewWealth({ holds: {} })).toThrow(/pass WITH_WEALTH/);
    // Another key's answer is not this one's.
    expect(() => canViewWealth({ holds: { [VIEW_COST]: true } })).toThrow(/pass WITH_WEALTH/);
  });
});

describe("WITH_WEALTH", () => {
  it("asks for See wealth data, which the gates accept when the route or router loads", () => {
    expect(WITH_WEALTH).toEqual({ also: [VIEW_WEALTH] });
    expect(() => requirePermission("marketing.lists", noop, WITH_WEALTH)).not.toThrow();
    expect(() => permissionProcedure("marketing.lists", WITH_WEALTH)).not.toThrow();
  });
});
