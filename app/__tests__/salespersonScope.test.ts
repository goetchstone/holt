// /app/__tests__/salespersonScope.test.ts
import {
  ALL_SALESPEOPLE,
  canSeeAllSalespeople,
  salespersonForCaller,
} from "@/lib/reports/salespersonScope";
import { isPermissionKey } from "@/lib/auth/permissionCatalog";

describe("salespersonForCaller", () => {
  it("lets a holder pick any salesperson", () => {
    expect(
      salespersonForCaller({ seesEveryone: true, requested: "Ann", selfDisplayName: "Bo" }),
    ).toBe("Ann");
  });
  it("gives a holder who asked for nobody an empty answer, as before", () => {
    expect(
      salespersonForCaller({ seesEveryone: true, requested: undefined, selfDisplayName: "Bo" }),
    ).toBe("");
    expect(
      salespersonForCaller({ seesEveryone: true, requested: null, selfDisplayName: "Bo" }),
    ).toBe("");
  });
  it("scopes a non-holder to themselves whatever they send", () => {
    expect(
      salespersonForCaller({ seesEveryone: false, requested: "Ann", selfDisplayName: "Bo" }),
    ).toBe("Bo");
    expect(
      salespersonForCaller({ seesEveryone: false, requested: "", selfDisplayName: "Bo" }),
    ).toBe("Bo");
  });
  it("gives a non-holder with no staff record nothing, never the requested name", () => {
    expect(
      salespersonForCaller({ seesEveryone: false, requested: "Ann", selfDisplayName: null }),
    ).toBe("");
  });
});

describe("canSeeAllSalespeople", () => {
  it("reads the gate's answer", () => {
    expect(canSeeAllSalespeople({ holds: { [ALL_SALESPEOPLE]: true } })).toBe(true);
    expect(canSeeAllSalespeople({ holds: { [ALL_SALESPEOPLE]: false } })).toBe(false);
  });
  it("throws when the gate never asked", () => {
    expect(() => canSeeAllSalespeople({ holds: {} })).toThrow(/WITH_ALL_SALESPEOPLE/);
  });
  it("names a real catalog key", () => {
    expect(isPermissionKey(ALL_SALESPEOPLE)).toBe(true);
  });
});
