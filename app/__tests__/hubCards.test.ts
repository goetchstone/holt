// /app/__tests__/hubCards.test.ts
//
// Hub cards follow the pages they open (lib/auth/hubCards.ts): a card shows
// when the viewer holds its page's key, from PAGE_ACCESS, plus its override's
// key where the page opens wider than its data. Cards used to carry role
// arrays, so a store's own role (enum DESIGNER) saw only the cards no array
// named, and a card could show to a role its page refused.
//
// Three layers:
//   1. the rules, on cards to real manifest pages;
//   2. the tripwire (CLAUDE.md rule 65): every card on every hub opens a page
//      the manifest lists, none rides a page still on a role list without an
//      override, and every override is current, a real key, and explained;
//   3. every hub page, run for real with requirePage stood in: it asks for each
//      key its cards need, and shows a card exactly when those keys are held.

jest.mock("@/lib/auth/requirePage", () => ({ requirePage: jest.fn() }));
jest.mock("@/lib/gettingStartedServer", () => ({ loadGettingStarted: jest.fn(async () => []) }));

import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";
import { isValidElement, type ReactNode } from "react";
import CardGrid from "@/components/layout/CardGrid";
import { requirePage } from "@/lib/auth/requirePage";
import { PAGE_ACCESS } from "@/lib/auth/pagePermissions";
import { isPermissionKey } from "@/lib/auth/permissionCatalog";
import {
  CARD_KEY_OVERRIDES,
  cardKeys,
  cardPage,
  hubCardKeys,
  visibleHubCards,
} from "@/lib/auth/hubCards";

const card = (href: string) => ({ title: href, description: "", href });
const holding =
  (...keys: string[]) =>
  (key: string) =>
    keys.includes(key);
const holdsFor = (cards: { href: string }[], held: (key: string) => boolean) =>
  Object.fromEntries(hubCardKeys(cards).map((key) => [key, held(key)]));

describe("the rules", () => {
  it("strips the query string and fragment to find the page", () => {
    expect(cardPage("/app/sales/orders?status=QUOTE")).toBe("/app/sales/orders");
    expect(cardPage("/app/admin/reports/commission-tiers?tab=locked")).toBe(
      "/app/admin/reports/commission-tiers",
    );
    expect(cardPage("/app/sales/orders#top")).toBe("/app/sales/orders");
    expect(cardPage("/app/sales/orders")).toBe("/app/sales/orders");
  });

  it("shows a card to a page open to all staff with no key at all", () => {
    expect(PAGE_ACCESS["/app"].permission).toBeNull();
    expect(cardKeys("/app")).toEqual([]);
    expect(visibleHubCards([card("/app")], {})).toHaveLength(1);
  });

  it("shows a card when the viewer holds its page's key, and hides it when not", () => {
    expect(PAGE_ACCESS["/app/sales/orders"].permission).toBe("sales.read");
    const quotes = [card("/app/sales/orders?status=QUOTE")];
    expect(hubCardKeys(quotes)).toEqual(["sales.read"]);
    expect(visibleHubCards(quotes, { "sales.read": true })).toEqual(quotes);
    expect(visibleHubCards(quotes, { "sales.read": false })).toEqual([]);
    // A key the page never asked for answers nothing: hidden, not shown.
    expect(visibleHubCards(quotes, {})).toEqual([]);
  });

  it("hides a card whose page the manifest does not list, whatever is held", () => {
    expect(PAGE_ACCESS["/app/inventory/products/configure"]).toBeUndefined();
    expect(cardKeys("/app/inventory/products/configure")).toBeNull();
    const everything = { "catalog.write": true, "catalog.read": true, "admin.settings": true };
    expect(visibleHubCards([card("/app/inventory/products/configure")], everything)).toEqual([]);
  });

  it("needs the override's key beside the page's own where the page opens wider than its data", () => {
    const pipeline = [card("/app/sales/pipeline")];
    expect(cardKeys("/app/sales/pipeline")).toEqual(["sales.read", "sales.lead"]);
    expect(visibleHubCards(pipeline, holdsFor(pipeline, holding("sales.read")))).toEqual([]);
    expect(visibleHubCards(pipeline, holdsFor(pipeline, holding("sales.lead")))).toEqual([]);
    expect(
      visibleHubCards(pipeline, holdsFor(pipeline, holding("sales.read", "sales.lead"))),
    ).toEqual(pipeline);
  });

  it("hides a card whose page still gates on a role list, unless an override stands in", () => {
    const pending = Object.keys(PAGE_ACCESS).filter((page) => PAGE_ACCESS[page].widensFrom);
    expect(pending.length).toBeGreaterThan(0);
    for (const page of pending) {
      const override = CARD_KEY_OVERRIDES[page];
      const cards = [card(page)];
      const all = holdsFor(cards, () => true);
      if (override) {
        // The page's mapped key is not what it enforces, so only the override counts.
        expect({ page, keys: cardKeys(page) }).toEqual({ page, keys: [override.permission] });
        expect(visibleHubCards(cards, all)).toEqual(cards);
      } else {
        expect({ page, keys: cardKeys(page) }).toEqual({ page, keys: null });
        expect(visibleHubCards(cards, all)).toEqual([]);
      }
    }
  });

  it("asks for each key once, however many cards need it", () => {
    const cards = [card("/app/sales/orders"), card("/app/sales/customers"), card("/app")];
    expect(hubCardKeys(cards)).toEqual(["sales.read"]);
  });
});

// ---------------------------------------------------------------------------
// The tripwire (rule 65)
// ---------------------------------------------------------------------------

const APP_DIR = join(__dirname, "..", "src", "app");
const DASHBOARD = join(APP_DIR, "(dashboard)");

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pageFiles(path);
    return name === "page.tsx" ? [path] : [];
  });
}

const HUBS = pageFiles(APP_DIR)
  .filter((file) => readFileSync(file, "utf8").includes('from "@/components/layout/CardGrid"'))
  .sort();
const hrefsOf = (file: string) =>
  [...readFileSync(file, "utf8").matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
const ALL_HREFS = HUBS.flatMap(hrefsOf);
const label = (file: string) => relative(APP_DIR, file);

describe("every hub card opens a page that decides who sees it", () => {
  it("finds the hubs it was written for, each with cards", () => {
    expect(HUBS.length).toBeGreaterThanOrEqual(13);
    for (const hub of HUBS) {
      expect({ hub: label(hub), cards: hrefsOf(hub).length > 0 }).toEqual({
        hub: label(hub),
        cards: true,
      });
    }
  });

  it("links only to pages the manifest lists", () => {
    const unlisted = HUBS.flatMap((hub) =>
      hrefsOf(hub)
        .filter((href) => !(cardPage(href) in PAGE_ACCESS))
        .map((href) => `${label(hub)}: ${href}`),
    );
    expect(unlisted).toEqual([]);
  });

  it("links to a page still on a role list only through an override", () => {
    const pending = HUBS.flatMap((hub) =>
      hrefsOf(hub)
        .filter((href) => PAGE_ACCESS[cardPage(href)]?.widensFrom)
        .filter((href) => !(cardPage(href) in CARD_KEY_OVERRIDES))
        .map((href) => `${label(hub)}: ${href}`),
    );
    expect(pending).toEqual([]);
  });

  it("keeps every override current, keyed and explained, and no more of them", () => {
    const linked = new Set(ALL_HREFS.map(cardPage));
    for (const [page, override] of Object.entries(CARD_KEY_OVERRIDES)) {
      expect({
        page,
        linkedFromAHub: linked.has(page),
        realKey: isPermissionKey(override.permission),
        differsFromPageKey: override.permission !== PAGE_ACCESS[page]?.permission,
        explained: override.reason.length > 25,
      }).toEqual({
        page,
        linkedFromAHub: true,
        realKey: true,
        differsFromPageKey: true,
        explained: true,
      });
    }
    // A ratchet: the six page/data mismatches and the pending House Calls page.
    // Growing it needs a written argument; settling a page shrinks it.
    expect(Object.keys(CARD_KEY_OVERRIDES).length).toBeLessThanOrEqual(7);
  });
});

// ---------------------------------------------------------------------------
// Every hub page, run
// ---------------------------------------------------------------------------

type Item = { href: string };

/** The cards handed to CardGrid, wherever it sits in what the page rendered. */
function cardGridItems(node: ReactNode): Item[] | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = cardGridItems(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ items?: Item[]; children?: ReactNode }>(node)) return null;
  if (node.type === CardGrid) return node.props.items ?? [];
  return cardGridItems(node.props.children);
}

/** Run a hub page as a viewer holding the keys `held` answers yes for. */
async function render(file: string, held: (key: string) => boolean) {
  const calls: { permission?: string; also?: readonly string[] }[] = [];
  (requirePage as jest.Mock).mockImplementation(
    async (_roles: unknown, options: { permission?: string; also?: readonly string[] }) => {
      calls.push(options);
      const holds = Object.fromEntries((options.also ?? []).map((key) => [key, held(key)]));
      return { userId: "u1", role: "X", holds };
    },
  );
  const Page = require(file).default as () => Promise<ReactNode>;
  const items = cardGridItems(await Page());
  expect(calls).toHaveLength(1);
  return { options: calls[0], hrefs: (items ?? []).map((item) => item.href) };
}

const routeOf = (file: string) => `/${relative(DASHBOARD, dirname(file))}`;

describe.each(HUBS.map((hub) => [label(hub), hub]))("%s", (_label, hub) => {
  const hrefs = hrefsOf(hub);

  it("gates on its own manifest key and asks for every key its cards need", async () => {
    const { options } = await render(hub, () => true);
    expect(options.permission).toBe(PAGE_ACCESS[routeOf(hub)].permission);
    const needed = [...new Set(hrefs.flatMap((href) => cardKeys(href) ?? []))].sort();
    expect([...(options.also ?? [])].sort()).toEqual(needed);
  });

  it("shows the Owner, who holds every key, every card", async () => {
    expect((await render(hub, () => true)).hrefs).toEqual(hrefs);
  });

  it("shows a viewer holding no card key only the cards to pages open to all", async () => {
    const open = hrefs.filter(
      (href) =>
        PAGE_ACCESS[cardPage(href)].permission === null && !(cardPage(href) in CARD_KEY_OVERRIDES),
    );
    expect((await render(hub, () => false)).hrefs).toEqual(open);
  });

  it("hides each card from a viewer missing one of its keys", async () => {
    for (const href of hrefs) {
      const keys = cardKeys(href) ?? [];
      for (const missing of keys) {
        const shown = (await render(hub, (key) => key !== missing)).hrefs;
        expect({ href, missing, shown: shown.includes(href) }).toEqual({
          href,
          missing,
          shown: false,
        });
      }
    }
  });
});
