// /app/src/lib/tax/resolveTaxRate.ts
//
// THE BUG THIS REPLACES: create-from-cart.ts and import-hd-proposal.ts both
// resolved tax with
//
//   tx.taxDistrict.findFirst({ where: { shortName: "CT", isActive: true },
//     include: { rules: { orderBy: { sortOrder: "asc" }, take: 1 } } })
//
// Two literals, one bug. "CT" is a fact about ONE deployment compiled into
// the product (CLAUDE.md rule 61) -- a store in any other state charged
// zero sales tax, silently, because the district just wasn't found. And
// `take: 1` collapsed the entire TaxRule model -- triggerPrice/triggerStop
// gates, a startPrice/stopPrice taxable band, chained rules, tax-included
// pricing -- into "whichever rule sorts first," which only ever looked
// right because the seed data has exactly one flat rule.
//
// RESOLUTION ORDER (most specific first) -- resolveTaxDistrict():
//
//   1. Customer tax exemption (Customer.taxExemptReasonId) -> isExempt, and
//      rate is forced to 0 downstream. This is the one part of the old
//      code that already worked; the check is preserved exactly (same
//      column, same truthiness test).
//   2. The customer's own district (Customer.defaultTaxDistrictId), if set
//      -- a trade account billed out of a different state than the store
//      that rang the sale, for example.
//   3. The selling store's district (StoreLocation.taxDistrictId). This is
//      the FK that didn't exist before this change (see the migration
//      alongside this file) -- a chain with stores in two states is the
//      ordinary case, not an edge case.
//   4. The deployment's configured default (AppSettings.defaultTaxDistrictId)
//      -- a real database row an admin or a seed sets, never a string
//      literal in source.
//   5. Nothing resolvable: rate 0, and a warning naming the store, because
//      silently charging no tax is exactly how this bug survived in
//      production for as long as it did.
//
// Note step 1 does NOT short-circuit the district lookup -- an exempt
// customer's order still records which district it WOULD have been taxed
// in (matching the old code's behaviour: `taxDistrictId` was always set
// from the resolved district, only `taxRate` was zeroed for an exemption).
// That's real information for reporting ("we would have collected $X in
// Massachusetts from this reseller") that a null district would throw away.
//
// PER-LINE BANDING -- rateForLineAmount():
//
// A TaxDistrict's rules are evaluated per line, not once per order, because
// TaxRule models a price-banded schedule, not a single flat percentage:
//
//   - triggerPrice / triggerStop gate whether a rule applies at all: the
//     line amount must fall inside [triggerPrice, triggerStop] (either
//     bound may be null, meaning unbounded on that side).
//   - startPrice / stopPrice gate the same way -- both are read as an
//     eligibility band on the line amount, not (yet) as "tax only the
//     portion of the price inside this band." See the NOT IMPLEMENTED note
//     below for why.
//   - Rules are tried in `sortOrder` order and the FIRST one whose bands
//     (if any) admit the line amount wins. A rule with every band field
//     null always admits, which is why a flat single-rule district (every
//     seeded district today) behaves exactly as it did under the old
//     `take: 1` -- there's nothing to gate on, so the only rule always
//     wins, at its own flat rate. This is what keeps a CT deployment's
//     numbers byte-identical (see cartPricingEndToEnd.integration.test.ts).
//   - No rule admits the amount -> rate 0 for that line. A real banded
//     schedule (e.g. "clothing under $175 is exempt") legitimately produces
//     zero tax on some lines; that is a correct answer, not a failure, so
//     it is not logged.
//
// "line amount" here is the DISCOUNTED line total (after item- and
// order-level discounts), matching cartPricing.ts's existing rule that tax
// is charged on what the customer actually pays, not the list price.
//
// NOT IMPLEMENTED, ON PURPOSE (CLAUDE.md rule 48: every finding ends in
// fixed / tripwire-tested / explicit won't-fix, never silent):
//
//   - `taxIncludedInSalesPrice` (back out an embedded tax rather than add
//     one) and `ruleToAddBeforeCalcId` (chain one rule's result into
//     another's base) are read but not evaluated -- a matched rule's flat
//     `taxRate` is applied regardless. Both are real VAT/compound-tax
//     features; modeling them correctly (order of evaluation, rounding at
//     each link) is a bigger change than this fix, and no seeded or
//     production district uses either today. If a district's rules use
//     them, `resolveTaxDistrict` logs a warning once per order naming the
//     district and the rule ids, so the gap is visible instead of silently
//     wrong.
//   - Per-product `TaxGroup` selection: TaxRule.groupId is required, but no
//     model links a Product (or OrderLineItem) to a TaxGroup -- that FK
//     does not exist in the schema. Every rule for the resolved district is
//     evaluated regardless of group, in sortOrder, which reproduces the old
//     `take: 1` behaviour exactly for a single-group district (every seed
//     today) and is the least-surprising choice without a real per-product
//     signal to key off of. Wiring an actual per-product tax group is a
//     schema change (Product.taxGroupId or similar) left for a follow-up.

import type { PrismaTx } from "@/lib/inventory/allocation";
import { logger } from "@/lib/logger";

/** A TaxRule, decimals already converted to number for arithmetic. */
export interface TaxDistrictRule {
  id: number;
  taxRate: number;
  triggerPrice: number | null;
  triggerStop: number | null;
  startPrice: number | null;
  stopPrice: number | null;
  taxIncludedInSalesPrice: boolean;
  ruleToAddBeforeCalcId: number | null;
  sortOrder: number;
}

export type TaxDistrictSource =
  "customer-district" | "store-district" | "app-default" | "unresolved";

export interface ResolvedTaxDistrict {
  taxDistrictId: number | null;
  /** True when Customer.taxExemptReasonId is set. Callers must force every
   *  line's rate to 0 when this is true -- `rules` is already empty so
   *  `rateForLineAmount` does this for free, but SalesOrder.taxExemptReasonId
   *  is a separate write callers still need to make themselves. */
  isExempt: boolean;
  source: TaxDistrictSource;
  /** Active rules for `taxDistrictId`, sorted by sortOrder. Empty when
   *  exempt or unresolved. */
  rules: TaxDistrictRule[];
}

export interface ResolveTaxDistrictInput {
  customerId?: number | null;
  storeLocationId?: number | null;
  /** Named in the "nothing resolved" warning log -- the store name/code, or
   *  a short description of the call site when no store applies (e.g. an
   *  HD proposal import has no store at all). */
  contextLabel: string;
}

async function loadActiveRules(tx: PrismaTx, taxDistrictId: number): Promise<TaxDistrictRule[]> {
  const rows = await tx.taxRule.findMany({
    where: { districtId: taxDistrictId, isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    taxRate: Number(r.taxRate),
    triggerPrice: r.triggerPrice != null ? Number(r.triggerPrice) : null,
    triggerStop: r.triggerStop != null ? Number(r.triggerStop) : null,
    startPrice: r.startPrice != null ? Number(r.startPrice) : null,
    stopPrice: r.stopPrice != null ? Number(r.stopPrice) : null,
    taxIncludedInSalesPrice: r.taxIncludedInSalesPrice,
    ruleToAddBeforeCalcId: r.ruleToAddBeforeCalcId,
    sortOrder: r.sortOrder,
  }));
}

/**
 * Resolve the tax district for a sale, once per order -- the per-line band
 * evaluation in `rateForLineAmount` is pure and needs no further query.
 */
export async function resolveTaxDistrict(
  tx: PrismaTx,
  input: ResolveTaxDistrictInput,
): Promise<ResolvedTaxDistrict> {
  const { customerId, storeLocationId, contextLabel } = input;

  let isExempt = false;
  let customerDistrictId: number | null = null;

  if (customerId) {
    const customer = await tx.customer.findUnique({
      where: { id: customerId },
      select: { taxExemptReasonId: true, defaultTaxDistrictId: true },
    });
    // Preserved exactly from the old code: truthiness of taxExemptReasonId,
    // not the separate Customer.taxExempt boolean.
    if (customer?.taxExemptReasonId) isExempt = true;
    customerDistrictId = customer?.defaultTaxDistrictId ?? null;
  }

  let taxDistrictId: number | null = null;
  let source: TaxDistrictSource = "unresolved";

  if (customerDistrictId) {
    taxDistrictId = customerDistrictId;
    source = "customer-district";
  } else if (storeLocationId) {
    const store = await tx.storeLocation.findUnique({
      where: { id: storeLocationId },
      select: { taxDistrictId: true },
    });
    if (store?.taxDistrictId) {
      taxDistrictId = store.taxDistrictId;
      source = "store-district";
    }
  }

  if (!taxDistrictId) {
    // Single-org-per-deployment (docs/TENANCY.md) -- at most one AppSettings
    // row exists, so there's no organization filter to get wrong here.
    const settings = await tx.appSettings.findFirst({
      select: { defaultTaxDistrictId: true },
    });
    if (settings?.defaultTaxDistrictId) {
      taxDistrictId = settings.defaultTaxDistrictId;
      source = "app-default";
    }
  }

  if (!taxDistrictId) {
    logger.warn(
      "resolveTaxRate: no tax district resolved for sale -- charging zero tax. " +
        "Set StoreLocation.taxDistrictId for this store or AppSettings.defaultTaxDistrictId.",
      { store: contextLabel },
    );
    return { taxDistrictId: null, isExempt, source: "unresolved", rules: [] };
  }

  const rules = isExempt ? [] : await loadActiveRules(tx, taxDistrictId);

  const unimplemented = rules.filter(
    (r) => r.ruleToAddBeforeCalcId != null || r.taxIncludedInSalesPrice,
  );
  if (unimplemented.length > 0) {
    logger.warn(
      "resolveTaxRate: district has rules using chained calculation (ruleToAddBeforeCalcId) " +
        "or tax-included pricing (taxIncludedInSalesPrice) -- neither is evaluated; " +
        "applying each matched rule's flat taxRate only.",
      { taxDistrictId, ruleIds: unimplemented.map((r) => r.id) },
    );
  }

  return { taxDistrictId, isExempt, source, rules };
}

export interface LineRateResult {
  rate: number;
  ruleId: number | null;
}

/**
 * Pure: pick the first active rule (in sortOrder) whose trigger/price bands
 * admit `lineAmount`, and return its flat rate. No DB access -- call this
 * once per line against the `rules` a single `resolveTaxDistrict` call
 * already loaded for the order, not once per line against the database.
 *
 * A rule with every band field null always admits (the flat-rate case every
 * seed uses today). No admitting rule -> rate 0, which is a legitimate
 * outcome for a genuinely banded schedule (an under-threshold exemption),
 * not logged as an error.
 */
export function rateForLineAmount(rules: TaxDistrictRule[], lineAmount: number): LineRateResult {
  for (const rule of rules) {
    if (rule.triggerPrice != null && lineAmount < rule.triggerPrice) continue;
    if (rule.triggerStop != null && lineAmount > rule.triggerStop) continue;
    if (rule.startPrice != null && lineAmount < rule.startPrice) continue;
    if (rule.stopPrice != null && lineAmount > rule.stopPrice) continue;
    return { rate: rule.taxRate, ruleId: rule.id };
  }
  return { rate: 0, ruleId: null };
}
