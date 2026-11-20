// /app/e2e/redirects.ts
//
// Pages that redirect on purpose, and where to. pages.spec.ts fails any other
// redirect for the Owner (a redirected page was never rendered), and checks a
// listed page lands exactly where this says. __tests__/e2eDynamicRoutes.test.ts
// checks each entry names a real page and says why.

export interface Redirect {
  /** The pathname the page lands on. */
  to: string;
  reason: string;
}

export const REDIRECTS: Record<string, Redirect> = {
  "/app/admin/pricing/import/wesley-hall": {
    to: "/app/admin/pricing/import",
    reason:
      "backward-compatible link: the vendor's importer is a source on the generic import page",
  },
  "/app/reports/commission": {
    to: "/app/admin/reports/commission-tiers",
    reason: "the old Commission report link opens the commission screen on its Locked tab",
  },
};
