// /app/__tests__/salespersonScope.test.ts
import {
  ALL_SALESPEOPLE,
  canSeeAllSalespeople,
  SALES_BY_SALESPERSON_EVERYONE,
  salesBySalespersonSeesEveryone,
  salespersonForCaller,
  WITH_SALES_BY_SALESPERSON_EVERYONE,
} from "@/lib/reports/salespersonScope";
import { isPermissionKey } from "@/lib/auth/permissionCatalog";

const LISTS = "marketing.lists";

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
  it("is not opened by See customer lists: Marketing does not gain the three salesperson reports", () => {
    expect(canSeeAllSalespeople({ holds: { [ALL_SALESPEOPLE]: false, [LISTS]: true } })).toBe(
      false,
    );
  });
});

describe("salesBySalespersonSeesEveryone (Sales by Salesperson only)", () => {
  it("opens every salesperson to a holder of either key", () => {
    for (const [all, lists, expected] of [
      [true, false, true],
      [false, true, true],
      [true, true, true],
      [false, false, false],
    ] as const) {
      expect({
        all,
        lists,
        seesEveryone: salesBySalespersonSeesEveryone({
          holds: { [ALL_SALESPEOPLE]: all, [LISTS]: lists },
        }),
      }).toEqual({ all, lists, seesEveryone: expected });
    }
  });
  it("throws unless the gate asked for both keys, so a holder is never scoped by omission", () => {
    expect(() => salesBySalespersonSeesEveryone({ holds: {} })).toThrow(
      /WITH_SALES_BY_SALESPERSON_EVERYONE/,
    );
    // Asked only the three siblings' key: a See customer lists holder would read as "no".
    expect(() => salesBySalespersonSeesEveryone({ holds: { [ALL_SALESPEOPLE]: true } })).toThrow(
      /WITH_SALES_BY_SALESPERSON_EVERYONE/,
    );
    expect(() => salesBySalespersonSeesEveryone({ holds: { [LISTS]: true } })).toThrow(
      /WITH_SALES_BY_SALESPERSON_EVERYONE/,
    );
  });
  it("asks exactly those two catalog keys, through the gate option the report's gates pass", () => {
    expect([...SALES_BY_SALESPERSON_EVERYONE]).toEqual([ALL_SALESPEOPLE, LISTS]);
    expect(WITH_SALES_BY_SALESPERSON_EVERYONE.also).toEqual(SALES_BY_SALESPERSON_EVERYONE);
    for (const key of SALES_BY_SALESPERSON_EVERYONE) expect(isPermissionKey(key)).toBe(true);
  });
});
