// /app/src/lib/glMapping.ts
//
// The shared vocabulary the JE generator (`lib/journalEntry.ts`) and the
// daily-reconciliation control (`lib/dailyReconciliation.ts`) both speak when
// they ask the database "which GL account plays this role here?"
//
// CLAUDE.md rule 61: a deployment's chart of accounts is config, not code.
// Holt's own chart happens to number cash `1-1006` and CT sales tax `2-2120`,
// but those are facts about ONE deployment. The product-level facts are the
// (section, label) keys below -- the rows an operator edits at
// /app/admin/setup/accounting. Rule 37: they live in exactly one file so a
// typo in one consumer cannot silently disagree with the other. A mistyped
// section here is a lookup that returns nothing, which is a $0.00 bucket that
// looks exactly like a clean day.

/** `SystemGLMapping.section` for payment-method -> GL resolution. */
export const POS_PAYMENTS_SECTION = "POS_PAYMENTS";

/** `SystemGLMapping.section` for the non-payment transaction GLs. */
export const POS_TRANSACTIONS_SECTION = "POS_TRANSACTIONS";

/**
 * Label of the combined-receipts account. Holt maps Cash / Card / Check /
 * Wire / ACH / Finance / Other to this one account (each tender still gets
 * its own journal line for memo clarity), so it is the account the
 * reconciliation sums for the "cash" bucket.
 */
export const CASH_MAPPING_LABEL = "Cash";

/**
 * Fallback sales-tax GL, used when an order's `TaxDistrict.glAccountId` is
 * unset. Districts are the primary source -- see `taxAccountIds` in
 * `lib/dailyReconciliation.ts`.
 */
export const SALES_TAX_MAPPING_LABEL = "Sales Tax";

/** The plug account. See OVER_SHORT_ALERT_THRESHOLD below. */
export const OVER_SHORT_MAPPING_LABEL = "Over/Short";

/**
 * Dollar magnitude above which an Over/Short plug stops being rounding noise
 * and starts being a missing payment or a missing line item.
 *
 * Below it: the JE generator still warns (every plug warns -- see
 * `buildJournalLines`), the reconciliation still reports the plug as its own
 * figure, and nobody is paged.
 *
 * Above it: `generateSalesJournal` additionally raises an ops alert
 * (`lib/opsAlert.ts`), and the reconciliation marks the day unbalanced so it
 * shows amber on /app/admin/automations/daily-reconciliation.
 *
 * NOT derived from production data (CLAUDE.md rule 41 asks for that and this
 * change had no production access -- say so rather than imply otherwise).
 * The reasoning is arithmetic instead: every leg of the JE is `round2()`d, so
 * a single line contributes at most half a cent of rounding error, and a busy
 * day is a few hundred lines. A dollar is comfortably above the worst case
 * and far below any real missing payment. Revisit against a month of real
 * plug values before treating it as tuned.
 */
export const OVER_SHORT_ALERT_THRESHOLD = 1.0;
