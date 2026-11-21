// /app/src/lib/auth/hubCards.ts
//
// Which hub cards a viewer sees. A card is a link, and the page it opens is the
// gate, so a card shows exactly when that page would let the viewer in: the
// page's key in PAGE_ACCESS (pagePermissions.ts), the one home of every page's
// key, which pagePermissions.test.ts binds to each page's requirePage literal.
// A role a store invents, or a key a store unticks, changes the cards with no
// further work, because the grant that opens a page is the grant that shows its
// card (PERM-01; before this, cards named roles, so a custom role saw only the
// cards no role list named).
//
// A hub page asks for its cards' keys beside its own gate (requirePage `also`,
// answered from the same staff read, View as included) and passes CardGrid only
// the cards those answers allow. The Owner holds every key, so sees every card.
//
// Fails closed: a card whose page PAGE_ACCESS does not list is hidden, and so
// is one whose page still gates on a role list (widensFrom), whose mapped key
// is not what the page enforces, unless CARD_KEY_OVERRIDES names a key for it.
//
// Pure and server-side: the hub pages import it; CardGrid never does.

import { PAGE_ACCESS, type PageAccess } from "@/lib/auth/pagePermissions";

export interface CardKeyOverride {
  /** The key a viewer also needs before the card shows. */
  permission: string;
  /** Why the page's own key is not enough. */
  reason: string;
}

/**
 * Cards that need a key beyond their page's own. Six pages open on a key wider
 * than the data they load, so a card on the page's key alone would send some
 * readers to a screen whose data call refuses them; one page still gates on a
 * role list awaiting the owner, so its card keeps today's audience. A ratchet
 * (CLAUDE.md rule 65): hubCards.test.ts fails on an entry without a reason, one
 * no hub card links to, one equal to its page's key, a card on a pending page
 * without an entry, and an eighth entry. Delete an entry once its page and its
 * data are settled on one key.
 */
export const CARD_KEY_OVERRIDES: Readonly<Record<string, CardKeyOverride>> = {
  "/app/sales/pipeline": {
    permission: "sales.lead",
    reason: "the page opens on sales.read, but /api/sales/pipeline needs sales.lead",
  },
  "/app/interactions": {
    permission: "customer.write",
    reason: "the page opens on customer.read, but /api/interactions needs customer.write",
  },
  "/app/sales/returns": {
    permission: "sales.return",
    reason: "the page opens on sales.read, but /api/returns needs sales.return",
  },
  "/app/sales/import-hd": {
    permission: "admin.data",
    reason: "the page opens on sales.read, but /api/sales/import-hd-proposal needs admin.data",
  },
  "/app/sales/till": {
    permission: "pos.till.manage",
    reason:
      "the page opens on sales.read, but its registers need pos.operate and opening or closing a till needs pos.till.manage",
  },
  "/app/reports/mailchimp/activity": {
    permission: "customer.read",
    reason: "the page opens on reporting.read, but /api/mailchimp/activities needs customer.read",
  },
  "/app/service/house-calls": {
    permission: "admin.settings",
    reason:
      "the page still gates on a role list awaiting the owner (widensFrom), so the card keeps its Owner and Administrator audience",
  },
};

/** The page a card opens: its href without the query string or fragment. */
export function cardPage(href: string): string {
  const cut = href.search(/[?#]/);
  return cut === -1 ? href : href.slice(0, cut);
}

/**
 * The keys a viewer must hold for a card to show: its page's own key (none for
 * a page open to all staff) and its override's. Null when the card must never
 * show: its page is not in the manifest, or still gates on a role list with no
 * override to stand in for it.
 */
export function cardKeys(href: string): readonly string[] | null {
  const page = cardPage(href);
  const access: PageAccess | undefined = PAGE_ACCESS[page];
  if (!access) return null;
  const override: CardKeyOverride | undefined = CARD_KEY_OVERRIDES[page];
  if (access.widensFrom) return override ? [override.permission] : null;
  return [access.permission, override?.permission].filter(
    (key): key is string => typeof key === "string",
  );
}

/** Every key a hub's cards need: pass it as requirePage's `also`. */
export function hubCardKeys(cards: readonly { href: string }[]): string[] {
  return [...new Set(cards.flatMap((card) => cardKeys(card.href) ?? []))];
}

/** The cards `holds` (requirePage's answer for hubCardKeys) lets the viewer see. */
export function visibleHubCards<T extends { href: string }>(
  cards: readonly T[],
  holds: Readonly<Record<string, boolean>>,
): T[] {
  return cards.filter((card) => {
    const keys = cardKeys(card.href);
    return keys !== null && keys.every((key) => holds[key] === true);
  });
}
