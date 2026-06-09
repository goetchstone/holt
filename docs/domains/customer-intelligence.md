# Customer Intelligence

How the business classifies, scores, and prioritizes its customers for sales follow-up. Covers three layered systems that feed into one another:

1. **Customer Leveling** — "Who is this customer to us?" (lifetime relationship)
2. **Lead Scoring** — "How likely are they to buy right now?" (opportunity)
3. **Wealth Enrichment** — "What do we know about their financial capacity?" (context)

If you only read one section, read the [How It All Fits Together](#how-it-all-fits-together) cheat sheet at the bottom.

---

## 1. Customer Leveling

**Source of truth**: `lib/customerLeveling.ts`. Recalculated by `POST /api/customers/recalculate-levels` (ADMIN only, run manually from the Customers page, 5-minute transaction).

### What we output

Six fields on `Customer`:

| Field | Meaning |
|---|---|
| `customerLevel` | 1–4 today (Occasional / Frequent / High Value / VIP) |
| `peakCustomerLevel` | Highest level this customer has ever reached. Never decreases. |
| `customerGroup` | Their dominant department group (FURNITURE / HOME_ACC / APPAREL / CHRISTMAS — regrouped 2026-04-25; legacy values HOME and LIFESTYLE persist until the next Recalculate Levels run) |
| `lifetimeSpend` | Sum of all non-cancelled line items ever |
| `lifetimeOrderCount` | Count of status ORDER/FULFILLED orders |
| `firstOrderDate` / `lastOrderDate` | For recency math |
| `departmentCount` | How many of the 4 department groups they've bought from |

### How levels are assigned

Every product belongs to a department, which maps to one of four groups:

| Group | Contains | Level window |
|---|---|---|
| FURNITURE | Furniture, Outdoor Furniture, Rugs, Curtains (+ legacy Bedroom/Dining Room/Outdoor/Window Treatments) | **12 months** |
| HOME_ACC | Home Acc, Tabletops, Bedding, Lamps, Prints, Mirrors, Bath, Floral, Childrens (+ Uncategorized fallback) | **12 months** |
| APPAREL | Womens Apparel, Mens Apparel, Apparel, Accessories | **6 months** |
| CHRISTMAS | Christmas seasonal goods | **Seasonal (Sept–Dec)** |

**2026-04-25 regroup:** previously the groups were HOME/LIFESTYLE/APPAREL/CHRISTMAS. HOME was split so hard-goods (furniture, rugs, curtains) stay together under FURNITURE, while the decorative items that used to live in HOME (bedding, lamps, mirrors, prints) joined the ex-LIFESTYLE decor depts in HOME_ACC. HOME_ACC's window was bumped from 6mo to 12mo since heavy decor has a slower cadence than bath/apparel. Migration `20260425_rename_customer_groups` nulls legacy HOME values pending the next Recalculate Levels run; LIFESTYLE values are mapped directly to HOME_ACC in the same migration.

A customer's level is assigned **per group** based on spend and order count within that group's window. They're assigned the **dominant group** (most spend) as their `customerGroup`, and that group's level becomes their `customerLevel`.

### Level thresholds

Each group has its own ladder, tuned to typical buying behavior:

- **Level 1 (Occasional)**: any qualifying purchase in window
- **Level 2 (Frequent)**: 2+ orders OR spend above a low threshold
- **Level 3 (High Value)**: 3+ orders and substantial spend
- **Level 4 (VIP)**: top tier — typically 4+ orders and high spend, or a single very-high-spend order

Exact numbers are in `lib/customerLeveling.ts` under `GROUP_THRESHOLDS`.

### Cross-shop bonus

If a customer has bought in **3+ of the 4 groups** in their window, they get **+1 level** (capped at 4). Someone who shops Apparel *and* Furniture *and* Home Accessories is more loyal than a single-group customer at the same spend.

### Peak vs. current

`peakCustomerLevel` only goes up, never down. A VIP who stops buying for 18 months will have `customerLevel` drop to 1 or 2 (they're dormant in their window) but `peakCustomerLevel` stays at 4. The customer page and dormant-customer reports use peak to show "Dormant — was VIP" badges.

This is also why lead scoring uses peak, not current — dormant VIPs are still hot leads worth chasing back.

### Excluded departments

Freight, MRC, Hardware, and TEAK-* are excluded from level calculations — they're not merchandise the customer "shopped" in a meaningful way.

---

## 2. Lead Scoring

**Source of truth**: `lib/leadScore.ts`. Pure function, no DB access. Tested in `__tests__/leadScore.test.ts`.

### What we output

```ts
{
  score: 0-100,
  tier: "HOT" | "WARM" | "COOL" | "NEW",
  factors: { spend, breadth, level, wealth, recency, lifeEvents },
  lifeEventReasons: ["Recent mover", "Recent mortgage", ...],
}
```

### The six factors

The score is additive across six signals, capped at 100.

| Factor | Weight (max) | What it measures | Why it matters |
|---|---:|---|---|
| **Lifetime spend** | 40 | Total $ ever with us | Biggest proven-intent signal |
| **Department breadth** | 15 | How many dept groups they've bought from | Broad shoppers have higher LTV |
| **Customer level** | 20 | Peak level (never decreases) | Captures relationship depth |
| **Wealth tier** | 20 | Net worth bucket from Windfall | Capacity to buy at higher price points |
| **Recency** | 5 | Days since last order | Recent buyers are most engaged |
| **Life events** | 10 (cap) | Windfall life-transition signals | Furniture follows life change |

**Lifetime spend** has the biggest weight because it's the most reliable signal — past behavior predicts future behavior better than anything else. Wealth and peak level are next. Life events are the newest factor (added April 2026) and stack on top for bonus points.

### Life events (April 2026 addition)

Moving correlates strongly with furniture purchase. New mortgage = new home = redecorating. A recent divorce often means a household reset. These signals come from Windfall enrichment and each contributes a small bonus up to a combined 10-point cap:

| Signal | Bonus |
|---|---:|
| Recent mover | +5 |
| Recent mortgage | +3 |
| Recently divorced | +2 |
| Money in motion | +2 |
| Liquidity trigger | +2 |

Stack up to 10. A WARM customer at score 65 who just moved jumps to 70 and becomes HOT. The `lifeEventReasons` array lists which signals fired, for "why is this HOT?" tooltips.

**Important**: life events boost the score even when wealth tier is hidden (for designer role). The signal "this customer is more likely to buy right now" is safe to surface to everyone; only the raw wealth number is privacy-restricted.

### Tier thresholds

- **HOT** (70+) — act today
- **WARM** (50–69) — follow up this week
- **COOL** (30–49) — on your list, not urgent
- **NEW** (< 30) — unknown potential

### Why peak level, not current

A dormant VIP has peak level 4 and current level 1. Using current would underscore their true value; using peak keeps them on the radar so we can try to re-engage.

### Where it's used

- Pipeline cards (`/sales/pipeline`) — tier shown to all roles, numeric score to ADMIN/MANAGER/MARKETING
- Leads board (`/leads`) — same
- Customer detail page — same
- Opportunity-style reports filter by tier

---

## 3. Wealth Enrichment (Windfall)

**Source of truth**: `WindfallEnrichment` model (1:1 with `Customer`), imported via `/admin/import/windfall` (ADMIN only). Weekly CSV export from Windfall's dashboard.

### Net worth + tier

The primary signal is `netWorth` (estimate). We bucket it:

| Tier | Threshold |
|---|---|
| **ULTRA_HIGH** | $10M+ |
| **VERY_HIGH** | $5M–$10M |
| **HIGH** | $1M–$5M |
| **AFFLUENT** | $500K–$1M |
| (null) | Below $500K or unknown |

### Lifestyle / asset signals (20+ booleans)

Windfall also flags dozens of life events and assets. We store all of them; only a few feed the lead score today:

**Used by lead score (life events):**

- `recentMover`, `recentMortgage`, `recentlyDivorced`, `moneyInMotion`, `liquidityTrigger`

**Stored but not yet feeding the score** (potential future signals):

- `boatOwner`, `planeOwner`, `multiPropertyOwner`, `rentalPropertyOwner` — asset ownership
- `philanthropicGiver`, `topPhilanthropicDonor`, `nonprofitBoardMember`, `donorAdvisedFunds` — philanthropy
- `politicalDonor`, `topPoliticalDonor`, `politicalParty` — political engagement
- `smallBusinessOwner` — entrepreneurial
- `cryptoInterest` — investment profile
- `recentDeathInFamily` — sensitive; deliberately not used for lead scoring

All are visible on the customer detail Wealth tab (ADMIN/MARKETING only).

### Match confidence

Windfall returns a `matchConfidence` (0–1) indicating how confident they are that their record matches our customer. We store it but don't currently filter on it. A future refinement could de-weight low-confidence matches.

### Role-based visibility

Wealth is sensitive. Strict rules:

- **Raw wealth data** (`netWorth`, `wealthTier`, Wealth Insights report, wealth tab on customer page): **ADMIN / MARKETING only**. The pipeline API omits `wealthTier` from the response for other roles so it can't even be read via the network inspector.
- **Lead tier** (HOT/WARM/COOL/NEW): all roles see it. Captures the wealth signal without exposing the raw data.
- **Numeric lead score**: ADMIN / MANAGER / MARKETING. Designers see tier only.
- **Life event signals on the score**: the *effect* (higher score) is visible to all; the *reasons list* is currently not surfaced to designers, but could be.

This two-layer model lets designers act on the signal without leaking sensitive data.

---

## How It All Fits Together

```
                 ┌─────────────────────────────────────┐
                 │      Customer (lifetime facts)       │
                 │  firstOrderDate, lifetimeSpend, etc. │
                 └──────────────┬──────────────────────┘
                                │
                  ┌─────────────┴─────────────┐
                  │                           │
      ┌───────────▼──────────┐     ┌──────────▼───────────┐
      │  Customer Leveling   │     │  Wealth Enrichment   │
      │  (lib/customerLevel) │     │   (Windfall import)  │
      │                      │     │                      │
      │  peakCustomerLevel   │     │  netWorth,           │
      │  departmentCount     │     │  wealthTier,         │
      │  customerGroup       │     │  recentMover, etc.   │
      └───────────┬──────────┘     └──────────┬───────────┘
                  │                           │
                  └─────────────┬─────────────┘
                                │
                    ┌───────────▼───────────┐
                    │    Lead Score         │
                    │    (lib/leadScore)    │
                    │                       │
                    │  0-100 + HOT/WARM/    │
                    │  COOL/NEW tier        │
                    └───────────┬───────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
  ┌─────▼──────┐        ┌───────▼──────┐         ┌──────▼──────┐
  │  Pipeline  │        │  Leads Board │         │  Customer   │
  │  cards     │        │  (Kanban)    │         │  detail     │
  └────────────┘        └──────────────┘         └─────────────┘
```

### The cheat sheet

1. **"Who is this customer?"** → `peakCustomerLevel` (1–4) + `lifetimeSpend`
2. **"How much money do they have?"** → `wealthTier` from Windfall (ADMIN/MARKETING only)
3. **"Are they about to buy?"** → Life events (recent mover, mortgage, divorce, money in motion)
4. **"What should I do about it?"** → `leadTier` 🔥/🙂/🙃/😐 (everyone sees it)

---

## When Things Get Recalculated

| Signal | Refreshed | Cadence |
|---|---|---|
| Customer levels | On-demand via `Recalculate Levels` button (ADMIN). Takes ~5 min. | Target: weekly (aligns with Windfall refresh) |
| Lifetime fields (`lifetimeSpend`, etc.) | Populated by the level recalculation above. | Same as above |
| Wealth enrichment | Manual CSV upload via `/admin/import/windfall`. | **Weekly** (Windfall's export cadence; life-event freshness depends on this) |
| Lead score | Computed on-the-fly every time a lead/pipeline/customer page loads. No cache. | Always current against the inputs above |

---

## Customer-Merge Gotcha (staff-email merging — fixed 2026-05-05)

**The bug**: `findOrCreateCustomer` in `lib/importHelpers.ts` matches incoming customers by `email` when the cuscode lookup misses. Salespeople sometimes typed their OWN email when entering customer records in the POS (commonly when the customer didn't supply one and the salesperson defaulted to their own as a placeholder). Every subsequent customer entered by the same salesperson then matched on email and got merged into the FIRST record.

**Damage at audit time** (2026-05-05): 138 distinct the POS customers wrongly clustered across ~20 of our customer records. Biggest case: 52 unique customers all merged into a single customer record via a staff member's email.

**Prevention**: helper `isUntrustedMergeEmail(email)` flags any email whose domain contains the value of the `COMPANY_EMAIL_DOMAIN` env var (case-insensitive substring match, so it also covers typo variants of the configured domain). When unset, the guard is a no-op. `findOrCreateCustomer` skips the email-match branch when untrusted, and stores NULL on create rather than the staff email. The customer importer similarly skips email-enrichment of existing customers when the incoming email is untrusted.

**Recovery** (PR #211, admin tool at `/admin/tools/customer-unmerge`):

1. Upload the full the POS customer CSV (8K rows)
2. Generate Preview → returns one row per (seed customer × cuscode) showing the planned action: KEEP / MERGE_INTO_NEW / MERGE_INTO_EXISTING_NEW
3. Download Preview CSV for offline review (recommended)
4. Apply Changes → per-customer transaction; partial failures don't block other records

The planner groups linked cuscodes by lower("firstName lastName") so the POS's "same person, multiple cuscodes" relationships are preserved (one new Customer record per unique-name group, multiple `CustomerExternalId` links attaching to it). The seed group (matching the existing record's name) stays in place; other groups spawn fresh records.

Audit trail: every new Customer is stamped with `createdBy = <admin-email>`; the preview CSV downloaded before apply is your before-state record.

## Known Gaps / Future Improvements

- **Life-event freshness depends on weekly Windfall refresh.** Windfall's booleans are snapshot-based — "recent mover" means Windfall's most-recent extract showed the customer as a recent mover. We trust the weekly refresh to keep these flags genuinely recent. **If the weekly import ever drifts, the flags go stale silently.** Check the import date on the customer Wealth tab if a score looks wrong.
- **Match confidence ignored** — we weight every Windfall record equally regardless of match certainty.
- **Asset signals unused in score** — boatOwner, planeOwner, etc. might be worth incorporating if we want to target luxury-furniture campaigns to known luxury-asset owners.
- **Philanthropy signals untapped** — donors often have disposable income; could be another life-event-like bonus.
- **No customer-level recalc cron yet** — today it's a manual button. Wire to Synology Task Scheduler to run weekly (aligns nicely with the Windfall refresh cadence).

---

## Campaign Attribution (Mailchimp Campaign Impact)

Answers the marketing director's real question: **"which campaigns made us money?"**

- **Report:** `/reports/mailchimp` — every campaign ranked by attributed revenue (default sort). The base engagement metrics (sent/opens/clicks) are still shown; they just no longer lead the table. Detail drill-down at `/reports/mailchimp/campaigns/[id]` adds a per-campaign attribution block: Purchasers / Orders / Attributed $ / Conversion %, revenue-by-department breakdown, and top-10 purchasers list.
- **Engine:** `lib/campaignAttribution.ts` — pure helper, no DB access, 20 unit tests in `__tests__/campaignAttribution.test.ts`.
- **Window:** 30 days from each customer's **first** engagement with that campaign. Later engagements don't re-anchor the window.
- **Engagement counted:** `open` or `click` with a matched `customerId`. Unlinked activities (no customer match) are surfaced as a blind-spot footnote on the detail page but not attributed.
- **Orders counted:** `SalesOrder.status` in (`ORDER`, `FULFILLED`), `orderDate` within the window. Cancelled line items excluded from the revenue sum (CLAUDE.md rule 33).
- **netPrice invariant** (CLAUDE.md): the attribution engine treats `OrderLineItem.netPrice` as the line total. Do **not** multiply by `orderedQuantity` inside the helper — it would double-count.
- **Attribution mode — last-touch (default in production):** each purchase credits exactly one campaign: the most recent engagement that still falls within the 30-day window. Summed revenue across campaigns equals true sales. Pass `mode: "shared"` to get non-exclusive per-campaign credit instead — useful for conversion-rate comparisons but NOT summable.
- **Brand-new-customer filter (60 days in production):** customers whose `Customer.firstOrderDate` falls within 60 days *before* a campaign's first engagement are dropped from that campaign's attribution. The business's flow: walk-in buys → gets added to the list → sees the next campaign → buys follow-on accessories. Without this filter every "newbie's second purchase" would inflate the next send. The 60-day buffer matches the typical follow-on window for a new furniture customer; tune `EXCLUDE_NEW_CUSTOMER_DAYS` in each endpoint if you want to tighten/loosen.
- **API:**
  - `GET /api/mailchimp/campaigns/db` — list view. Three DB queries for a page of 20 (campaigns + activities + candidate orders), then in-memory attribution. Sub-100ms for a 90-day range.
  - `GET /api/mailchimp/campaigns/[id]` — detail view, adds department rollup + top-10 purchasers enriched with name/email.
- **Feeds back into lead scoring & measurement** — see `docs/lead-scoring-explainer.md` ("Measuring it"). Once this report has a month or two of data, we can start comparing conversion-by-tier against attributed revenue to retune lead-score weights.

---

## Where to Make Changes

| What you want to change | File |
|---|---|
| Level thresholds (Occasional → VIP) | `lib/customerLeveling.ts` — `GROUP_THRESHOLDS` |
| Lead score weights | `lib/leadScore.ts` — `spendPoints`, `wealthPoints`, etc. |
| Tier thresholds (HOT/WARM/COOL/NEW cutoffs) | `lib/leadScore.ts` — `scoreToTier` |
| Life event weights or add new signals | `lib/leadScore.ts` — `LIFE_EVENT_WEIGHTS`, `lifeEventPoints` |
| Wealth tier thresholds | `lib/windfallImport.ts` — `computeWealthTier` |
| Role-based visibility rules | Pipeline API, leads API, customer detail page — search for `canSeeWealth` / `canSeeNumericScore` |

---

Last verified: 2026-04-22 (life events added to lead score)
