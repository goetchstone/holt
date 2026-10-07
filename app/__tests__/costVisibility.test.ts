// /app/__tests__/costVisibility.test.ts
//
// The guards around "View cost" (SEC-14) that are pure code: a route must ask
// for the key before it can answer it, a gate refuses a key that does not
// exist, and the row helper strips exactly the cost fields and says so.

import {
  canViewCost,
  dropCostWrites,
  rowsWithCostFor,
  VALUATION_COST_FIELDS,
  VIEW_COST,
} from "@/lib/auth/costVisibility";
import { requireAuthWithRole, requirePermission } from "@/lib/auth/requireAuth";
import { permissionProcedure, roleProcedure } from "@/server/trpc/trpc";

const noop = async () => {};

describe("canViewCost", () => {
  it("answers from the gate's holds", () => {
    expect(canViewCost({ holds: { [VIEW_COST]: true } })).toBe(true);
    expect(canViewCost({ holds: { [VIEW_COST]: false } })).toBe(false);
  });

  it("throws when the gate never asked, rather than stripping cost from holders too", () => {
    expect(() => canViewCost({ holds: {} })).toThrow(/pass WITH_COST/);
  });
});

describe("a gate's { also } keys", () => {
  it("must exist in the catalog, refused when the route loads", () => {
    expect(() => requirePermission("inventory.read", noop, { also: ["catalog.costs"] })).toThrow(
      /"catalog.costs" in \{ also \} is not a permission key/,
    );
    expect(() => requireAuthWithRole(["MANAGER"], noop, { also: ["nope"] })).toThrow(
      /not a permission key/,
    );
    expect(() => requirePermission("inventory.read", noop, { also: [VIEW_COST] })).not.toThrow();
  });

  it("the tRPC procedures refuse one too, when the router loads", () => {
    expect(() => roleProcedure(["MANAGER"], { also: ["nope"] })).toThrow(/not a permission key/);
    expect(() => permissionProcedure("reporting.read", { also: ["nope"] })).toThrow(
      /not a permission key/,
    );
    expect(() => roleProcedure(["MANAGER", "ADMIN"], { also: [VIEW_COST] })).not.toThrow();
  });
});

describe("rowsWithCostFor", () => {
  const rows = [
    { department: "Rugs", expectedQty: 3, expectedCost: 300, countedCost: 200, varianceCost: -100 },
  ];

  it("keeps the rows whole for a holder and says so", () => {
    expect(rowsWithCostFor({ holds: { [VIEW_COST]: true } }, rows, VALUATION_COST_FIELDS)).toEqual({
      rows,
      costVisible: true,
    });
  });

  it("drops exactly the cost fields for anyone else and says so", () => {
    expect(rowsWithCostFor({ holds: { [VIEW_COST]: false } }, rows, VALUATION_COST_FIELDS)).toEqual(
      {
        rows: [{ department: "Rugs", expectedQty: 3 }],
        costVisible: false,
      },
    );
  });
});

describe("dropCostWrites", () => {
  const body = { cost: 0, quality: "Hand-knotted", size: "8x10" };

  it("lets a holder's edit through whole", () => {
    expect(dropCostWrites({ holds: { [VIEW_COST]: true } }, body, ["cost"])).toEqual(body);
  });

  it("drops the cost fields from anyone else's edit, so a stripped screen cannot wipe cost", () => {
    expect(dropCostWrites({ holds: { [VIEW_COST]: false } }, body, ["cost"])).toEqual({
      quality: "Hand-knotted",
      size: "8x10",
    });
  });

  it("throws when the gate never asked, like canViewCost", () => {
    expect(() => dropCostWrites({ holds: {} }, body, ["cost"])).toThrow(/pass WITH_COST/);
  });
});
