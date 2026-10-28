// /app/src/lib/gettingStarted.ts
//
// The getting-started checklist: what a new store has to configure before its
// first sale, and whether it has. Pure -- plain facts in, items out -- so every
// item is unit-tested both ways without a database (CLAUDE.md rule 14). The
// Prisma reads live in gettingStartedServer.ts, which only fetches.
//
// Why it exists: nothing told a new store what to set up, and the worst gap was
// silent. With no tax district resolvable, resolveTaxRate.ts charges 0% tax and
// writes a warning to a server log nobody reads. The checklist puts that on the
// Admin hub instead, and the POS and New Quote screens say it at the register
// (taxDistrictConfigured below). The sale itself is never blocked.
//
// Every href is the page where the thing is actually set. Client-safe: no
// Prisma, no server imports.

export type GettingStartedKey = "stores" | "tax" | "region" | "markup" | "staff" | "payments";

export interface GettingStartedItem {
  key: GettingStartedKey;
  /** What to do, as an instruction. */
  label: string;
  done: boolean;
  /** The page where it is set. */
  href: string;
  /** Why it matters or what is missing; only on items not done. */
  detail?: string;
}

/** The facts the checklist is computed from. Counts, not rows: the loader's
 *  queries stay bounded however large the deployment grows. */
export interface GettingStartedFacts {
  activeStoreCount: number;
  /** Active stores with no taxDistrictId of their own: how many, and the first
   *  few names (for the detail line; may be shorter than `count`). */
  storesWithoutTaxDistrict: { count: number; names: string[] };
  activeTaxDistrictCount: number;
  /** AppSettings.defaultTaxDistrictId -- resolveTaxRate.ts's last resort. */
  defaultTaxDistrictId: number | null;
  /** AppSettings.setupConfirmedAt (ISO 8601), null until the owner confirms. */
  setupConfirmedAt: string | null;
  /** Vendors whose own defaultMarkup is a positive number. */
  vendorsWithMarkupCount: number;
  /** AppSettings.pricing.defaultMarkup, already parsed (null = unset). */
  storeWideDefaultMarkup: number | null;
  activeStaffCount: number;
  /** The processor that takes new card payments, and whether the credentials
   *  its client needs resolve (PaymentProvider.isConfigured). */
  paymentProvider: { name: string; configured: boolean };
  /** AppSettings.cashOnlyAcknowledgedAt (ISO 8601), null unless the owner said so. */
  cashOnlyAcknowledgedAt: string | null;
}

/**
 * Does a sale at this store resolve a tax district? Mirrors steps 3 and 4 of
 * resolveTaxRate.ts's resolution order (the store's own district, then the
 * deployment default); step 2, a customer's own district, is per-sale and not
 * knowable from the store. False means step 5: the sale is charged 0% tax.
 *
 * `storeTaxDistrictId` is undefined when there is no store at all (no active
 * store chosen) -- then only the default can answer.
 */
export function taxDistrictConfigured(
  storeTaxDistrictId: number | null | undefined,
  defaultTaxDistrictId: number | null | undefined,
): boolean {
  return storeTaxDistrictId != null || defaultTaxDistrictId != null;
}

const HREF = {
  stores: "/app/admin/setup/stores",
  taxDistricts: "/app/admin/setup/tax",
  defaultTaxDistrict: "/app/admin/settings#sales-tax",
  region: "/app/admin/settings#localization",
  markup: "/app/admin/pricing/configurator",
  staff: "/app/admin/staff",
  payments: "/app/admin/settings/integrations",
} as const;

function namesPhrase(names: string[], count: number): string {
  const shown = names.join(", ");
  const more = count - names.length;
  if (more > 0) return `${shown} and ${more} more ${more === 1 ? "store" : "stores"} have`;
  return count === 1 ? `${shown} has` : `${shown} have`;
}

function storesItem(f: GettingStartedFacts): GettingStartedItem {
  const done = f.activeStoreCount > 0;
  return {
    key: "stores",
    label: "Add your first store",
    done,
    href: HREF.stores,
    ...(done ? {} : { detail: "Every sale, stock count and tax rate belongs to a store." }),
  };
}

function taxItem(f: GettingStartedFacts): GettingStartedItem {
  const base = { key: "tax" as const, label: "Set up sales tax" };
  if (f.activeTaxDistrictCount === 0) {
    return {
      ...base,
      done: false,
      href: HREF.taxDistricts,
      detail: "There is no tax district yet, so every sale is charged 0% tax.",
    };
  }
  // The default covers every store. Without it, every active store needs its
  // own district -- and "every store" must not be vacuously true when there
  // are none: a sale with no store and no default still charges 0%.
  const everyStoreHasOne = f.activeStoreCount > 0 && f.storesWithoutTaxDistrict.count === 0;
  if (f.defaultTaxDistrictId != null || everyStoreHasOne) {
    return { ...base, done: true, href: HREF.defaultTaxDistrict };
  }
  const detail =
    f.storesWithoutTaxDistrict.count > 0
      ? `${namesPhrase(f.storesWithoutTaxDistrict.names, f.storesWithoutTaxDistrict.count)} no tax district and there is no default, so sales there are charged 0% tax.`
      : "There is no default tax district, so a sale with no store is charged 0% tax.";
  return { ...base, done: false, href: HREF.defaultTaxDistrict, detail };
}

function regionItem(f: GettingStartedFacts): GettingStartedItem {
  const done = f.setupConfirmedAt != null;
  return {
    key: "region",
    label: "Confirm your currency and timezone",
    done,
    href: HREF.region,
    ...(done
      ? {}
      : {
          detail: "Prices, receipts and every report's business day use them; check the defaults.",
        }),
  };
}

function markupItem(f: GettingStartedFacts): GettingStartedItem {
  const done = f.vendorsWithMarkupCount > 0 || f.storeWideDefaultMarkup != null;
  return {
    key: "markup",
    label: "Set a retail markup",
    done,
    href: HREF.markup,
    ...(done
      ? {}
      : { detail: "With no markup, the catalog shows wholesale cost and no retail price." }),
  };
}

function staffItem(f: GettingStartedFacts): GettingStartedItem {
  // The first account is the bootstrap admin; one more means someone else
  // can sign in and sell.
  const done = f.activeStaffCount > 1;
  return {
    key: "staff",
    label: "Add your staff",
    done,
    href: HREF.staff,
    ...(done ? {} : { detail: "Only one staff account exists so far." }),
  };
}

function paymentsItem(f: GettingStartedFacts): GettingStartedItem {
  const done = f.paymentProvider.configured || f.cashOnlyAcknowledgedAt != null;
  return {
    key: "payments",
    label: "Set up card payments, or say you take cash only",
    done,
    href: HREF.payments,
    ...(done
      ? {}
      : {
          detail: `${f.paymentProvider.name} takes card payments here and has no keys yet.`,
        }),
  };
}

/** Every checklist item, in the order a new store would do them. */
export function buildGettingStarted(facts: GettingStartedFacts): GettingStartedItem[] {
  return [
    storesItem(facts),
    taxItem(facts),
    regionItem(facts),
    markupItem(facts),
    staffItem(facts),
    paymentsItem(facts),
  ];
}

/** The items still to do. */
export function remainingItems(items: GettingStartedItem[]): GettingStartedItem[] {
  return items.filter((item) => !item.done);
}
