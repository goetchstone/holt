// /app/__tests__/e2eDynamicRoutes.test.ts
//
// Rule 65 for the browser smoke suite. pages.spec.ts opens every static page on
// its own, but a dynamic route (`[id]`, `[token]`) needs a value from the seed,
// and that is declared in e2e/dynamicRoutes.ts. A new dynamic page with no
// entry would never be opened, so this fails on it; it also fails on an entry
// for a route that no longer exists, and on a skip with no reason. The same
// holds for e2e/knownFailures.ts, the ratchet of pages found broken.

import { DYNAMIC_ROUTES } from "../e2e/dynamicRoutes";
import { KNOWN_FAILURES } from "../e2e/knownFailures";
import { isDynamic, pageRoutes } from "../e2e/pageRoutes";
import { REDIRECTS } from "../e2e/redirects";

const routes = pageRoutes();
const dynamic = routes.filter(isDynamic);

describe("e2e/dynamicRoutes.ts covers every dynamic page (rule 65)", () => {
  it("reads the page tree", () => {
    expect(routes.length).toBeGreaterThan(200);
    expect(routes).toContain("/app/sales/orders/[id]");
  });

  it("every dynamic route has an entry", () => {
    expect(dynamic.filter((r) => !(r in DYNAMIC_ROUTES))).toEqual([]);
  });

  it("every entry is a dynamic route that exists", () => {
    expect(Object.keys(DYNAMIC_ROUTES).filter((r) => !dynamic.includes(r))).toEqual([]);
  });

  it("every skip says why", () => {
    const bare = Object.entries(DYNAMIC_ROUTES)
      .filter(([, e]) => "skip" in e && e.skip.trim().length < 15)
      .map(([r]) => r);
    expect(bare).toEqual([]);
  });
});

describe("e2e/knownFailures.ts names real pages and says why", () => {
  it("every entry is a page route with a reason", () => {
    const bad = Object.entries(KNOWN_FAILURES)
      .filter(
        ([route, entry]) =>
          !routes.includes(route) ||
          entry.reason.trim().length < 15 ||
          !["owner", "admin"].includes(entry.as),
      )
      .map(([route]) => route);
    expect(bad).toEqual([]);
  });
});

describe("e2e/redirects.ts names real pages, a target and a reason", () => {
  it("every entry is a page route with a pathname target and a reason", () => {
    const bad = Object.entries(REDIRECTS)
      .filter(
        ([route, entry]) =>
          !routes.includes(route) || !entry.to.startsWith("/") || entry.reason.trim().length < 15,
      )
      .map(([route]) => route);
    expect(bad).toEqual([]);
  });
});
