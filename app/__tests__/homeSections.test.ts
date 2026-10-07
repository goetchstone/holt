// /app/__tests__/homeSections.test.ts
//
// The home page shows what the viewer's keys allow (F1, owner decision Q5):
// every staff member lands on /app, and each part of it follows a key, never a
// role name. Every combination of the two module flags and the two keys is
// checked, so a half-card shown without its key, or an empty page with no
// explanation, cannot come back.

import { homeSections, type HomeAccess } from "@/lib/homeSections";
import { permissionsForBuiltInRole } from "@/lib/auth/permissionCatalog";

const combos: HomeAccess[] = [];
for (const trafficModuleOn of [false, true])
  for (const upBoardOn of [false, true])
    for (const canSeeTraffic of [false, true])
      for (const canSeeSales of [false, true])
        combos.push({ trafficModuleOn, upBoardOn, canSeeTraffic, canSeeSales });

describe("homeSections", () => {
  it.each(combos)("never shows a half-card without its key: %j", (access) => {
    const { storeCards } = homeSections(access);
    if (storeCards) {
      expect(storeCards.traffic).toBe(access.canSeeTraffic);
      expect(storeCards.sales).toBe(access.canSeeSales);
      expect(access.trafficModuleOn).toBe(true);
    }
  });

  it.each(combos)("shows store cards exactly when the module is on and a key admits: %j", (a) => {
    const expected = a.trafficModuleOn && (a.canSeeTraffic || a.canSeeSales);
    expect(homeSections(a).storeCards !== null).toBe(expected);
  });

  it.each(combos)("the up board follows its module alone (staff.self is everyone): %j", (a) => {
    expect(homeSections(a).upBoard).toBe(a.upBoardOn);
  });

  it.each(combos)("explains an empty page, and only an empty one: %j", (a) => {
    const s = homeSections(a);
    const empty = s.storeCards === null && !s.upBoard;
    expect(s.notice !== null).toBe(empty);
    if (empty) {
      expect(s.notice).toBe(!a.trafficModuleOn && !a.upBoardOn ? "modulesOff" : "nothingForRole");
    }
  });

  it("titles the cards by what they show", () => {
    const base = { trafficModuleOn: true, upBoardOn: false };
    expect(
      homeSections({ ...base, canSeeTraffic: true, canSeeSales: true }).storeCards?.title,
    ).toBe("Store Traffic");
    expect(
      homeSections({ ...base, canSeeTraffic: false, canSeeSales: true }).storeCards?.title,
    ).toBe("Store Sales");
  });

  it("DESIGNER's built-in keys (from the catalog) give the full home page", () => {
    // DESIGNER used to be redirected away from /app; the redirect itself is
    // guarded by uiRoleNameBranches.test.ts.
    const keys = permissionsForBuiltInRole("DESIGNER");
    expect(
      homeSections({
        trafficModuleOn: true,
        upBoardOn: true,
        canSeeTraffic: keys.includes("reporting.traffic"),
        canSeeSales: keys.includes("sales.read"),
      }),
    ).toEqual({
      storeCards: { title: "Store Traffic", traffic: true, sales: true },
      upBoard: true,
      notice: null,
    });
  });
});
