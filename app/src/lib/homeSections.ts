// /app/src/lib/homeSections.ts
//
// What the home page (/app) shows, decided from the deployment's module flags
// and the viewer's keys, never from a role name. Every staff member lands on
// /app (owner decision Q5, 2026-09-24); before this, DESIGNER (and every
// custom role, which carries the DESIGNER enum) was redirected to /app/sales.
//
//   store cards  the Store Traffic module is on, and the viewer holds "View
//                store traffic" (reporting.traffic) or "View orders"
//                (sales.read). Each card shows only the half its key allows:
//                a viewer without sales.read sees no "$0 Net Sales".
//   up board     the Up Board module is on (staff.self, everyone).
//   notice       says why the page is empty, when it is.

export interface HomeAccess {
  trafficModuleOn: boolean;
  upBoardOn: boolean;
  /** reporting.traffic: the door-counter half of each store card. */
  canSeeTraffic: boolean;
  /** sales.read: the net-sales half (GET /api/dashboard/sales-summary). */
  canSeeSales: boolean;
}

export interface HomeSections {
  storeCards: { title: "Store Traffic" | "Store Sales"; traffic: boolean; sales: boolean } | null;
  upBoard: boolean;
  /** "modulesOff": both modules are off for the deployment. "nothingForRole":
   *  the modules are on, but this viewer holds none of the keys behind them. */
  notice: "modulesOff" | "nothingForRole" | null;
}

export function homeSections(access: HomeAccess): HomeSections {
  const { trafficModuleOn, upBoardOn, canSeeTraffic, canSeeSales } = access;

  const storeCards =
    trafficModuleOn && (canSeeTraffic || canSeeSales)
      ? {
          title: canSeeTraffic ? ("Store Traffic" as const) : ("Store Sales" as const),
          traffic: canSeeTraffic,
          sales: canSeeSales,
        }
      : null;

  let notice: HomeSections["notice"] = null;
  if (!trafficModuleOn && !upBoardOn) notice = "modulesOff";
  else if (!storeCards && !upBoardOn) notice = "nothingForRole";

  return { storeCards, upBoard: upBoardOn, notice };
}
