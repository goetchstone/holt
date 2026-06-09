# How Lead Scoring Works

*Plain-English explainer for the marketing team and leadership. Engineering version: `docs/domains/customer-intelligence.md`.*

---

## The one-paragraph version

Every customer gets a **0–100 lead score** that answers one question: *"How likely is this person to spend money with us in the near future?"* The score combines six signals, and lands the customer in one of four tiers — **Hot, Warm, Cool, New** — which drive who gets a call, who gets an email, and who gets a personal touch from a designer.

---

## The four tiers

| Tier | Score | Meaning | Action |
|---|---|---|---|
| 🔥 **Hot** | 70+ | Proven spender + ready-to-buy signal | Personal call or designer outreach |
| 🙂 **Warm** | 50–69 | Real opportunity, weaker timing signal | Email or call this week or next |
| 🙃 **Cool** | 30–49 | Keep in the loop, not a priority | Broader campaigns only |
| 😐 **New** | <30 | Little evidence they'll buy soon | Background awareness |

---

## The six ingredients

The six weights are deliberately balanced so **no single factor can push someone to Hot on its own** — a rich stranger who's never bought maxes the wealth factor and still lands Warm at best.

### 1. Lifetime spend — up to 40 points

| Lifetime spend | Points |
|---|---|
| $10,000+ | 40 |
| $5,000–10,000 | 25–40 |
| $1,000–5,000 | 15–25 |
| $100–1,000 | 0–15 |
| <$100 | 0 |

Biggest factor — past spend is the best predictor of future spend.

### 2. Department breadth — up to 15 points

How many of our four department groups they've shopped (**Furniture, Home Accessories, Apparel, Christmas**).

| Groups shopped | Points |
|---|---|
| 4 | 15 |
| 3 | 10 |
| 2 | 5 |
| 1 | 0 |

### 3. Customer level — up to 20 points

Their **peak** level — the highest Level (1–4) they've ever reached. Using peak instead of current means dormant VIPs stay flagged.

| Peak level | Points |
|---|---|
| 4 — VIP | 20 |
| 3 — High Value | 15 |
| 2 — Frequent | 10 |
| 1 — Occasional | 5 |

### 4. Wealth signal — up to 20 points

From the wealth-enrichment provider, refreshed weekly.

| Wealth tier | Points |
|---|---|
| Ultra-High | 20 |
| Very High | 15 |
| High | 10 |
| Affluent | 5 |
| No match | 0 |

Capped at 20 so wealth alone can't carry a non-buyer to Hot.

### 5. Recency — up to 5 points

| Last order | Points |
|---|---|
| Within 90 days | 5 |
| 90 days–6 months | 3 |
| 6 months–1 year | 1 |
| Older / never | 0 |

Small weight — recency is real but noisy, seasonal buyers cluster.

### 6. Life events — up to 10 bonus points

Stacks on top of the otherwise-capped 100. Each flag adds a few points, combined cap of 10.

| Flag | Points |
|---|---|
| Recently moved | +5 |
| Recent mortgage | +3 |
| Recently divorced | +2 |
| Money in motion | +2 |
| Liquidity trigger | +2 |

---

## Worked example

*Mary*, age 58:

- Lifetime spend **$14,000** (mostly bedroom + dining furniture)
- Shopped **1 group** (Furniture)
- Peak level **3 (High Value)** two years ago; now at Level 1
- Wealth data: **Very High**, two-home owner, boat owner
- Last order **14 months ago**
- **Recent mover** flag hit in this week's refresh

| Factor | Points |
|---|---|
| Lifetime spend | 40 |
| Breadth (1 group) | 0 |
| Peak level 3 | 15 |
| Wealth — Very High | 15 |
| Recency (14 mo) | 1 |
| Life event (mover) | +5 |
| **Total** | **76 → 🔥 Hot** |

Without the mover flag she's 71 (still Hot). Without wealth she's 61 (Warm). Without lifetime spend she's 36 (Cool). That's the point of the six-way split: no one factor dominates.

---

## Who sees what

| | Designer | Register | Manager | Marketing | Admin |
|---|:---:|:---:|:---:|:---:|:---:|
| Lead tier badge (🔥/🙂/🙃/😐) | ✓ | ✓ | ✓ | ✓ | ✓ |
| Exact score (76) | — | — | ✓ | ✓ | ✓ |
| Wealth tier | — | — | — | ✓ | ✓ |
| Raw wealth signals | — | — | — | ✓ | ✓ |

Designers see the tier but never wealth. The tier is actionable; the wealth detail is background.

---

## How to use it

- **Designers:** the tier is a suggestion, not a verdict. Trust what you know from a real conversation over the badge.
- **Marketing:** build weekly lists off the Opportunities hub — those segments are already scored and deduped. Combine tier with another filter (wealth tier, last purchase, department, customer group) rather than sending to "everyone Hot."
- **Leadership:** healthy distribution is roughly 5% Hot / 15% Warm / 30% Cool / 50% New. If Hot is under 2%, we're under-cultivating; if over 10%, the scoring is too loose and we should revisit weights.

---

## What it doesn't do

- Not a sales forecast — tier tells us *worth the touch*, not *will spend $X by Y*.
- Doesn't factor in complaints, returns, or damage claims.
- Life-event signals lag up to a week (wealth data refreshes weekly).
- Can't see competitor purchases — spend history only reflects us.

---

## Where the scoring shows up

- **Customer detail page** — tier badge next to the name.
- **Sales pipeline** — tier on every quote card.
- **Pipeline Opportunity** — tier in the drilldown.
- **Leads board** — board is sorted by tier.
- **Opportunities hub** — tiles filter on the underlying signals that feed the score.

---

## Measuring it (open question)

The weights above are a starting point, not a final calibration. To know whether the scoring is actually working, we need to track:

- **Conversion by tier** — what % of Hot leads buy within 30 / 60 / 90 days, vs Warm, vs Cool? If Hot and Warm have similar conversion, Hot isn't earning its name and the threshold needs to move up.
- **Revenue per touch by tier** — email + call hours spent against each tier, divided by attributed revenue in the following 30–60 days. Designer time is the scarce resource; that ratio tells us whether the tiering is guiding it well. The **Mailchimp Campaign Impact** report (`/reports/mailchimp`) is the first data source — every campaign is ranked by attributed revenue within 30 days of open or click, so once the score has been live for a few weeks we can start comparing tier engagement to downstream revenue.
- **False Hot rate** — manager's gut check on the Hot list each week. If 3 out of 20 Hot leads obviously shouldn't be there, something in the weights is off.
- **Missed Hot** — customers who bought big and weren't flagged Hot in the 30 days before the sale. Shows what signals we're missing.

Once we have a month or two of attribution data, we can retune the six weights and the tier thresholds. Until then, these numbers are our best starting guess — honestly, one designer's judgement on "who's ready to buy" is probably still more accurate than the score for any individual customer. The value of the score is that it scales: one designer can't look at thousands of customers every week, but the score can.

---

*Simplest sanity-check question for any tier call: "if I were a designer, would I call this person today?" If the tier agrees with your gut 80% of the time, the score is doing its job. The 20% is where we override it — and those overrides are how we'll tune the weights.*
