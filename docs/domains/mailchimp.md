# Mailchimp & Lead Intake

Email campaign sync, attribution, lead ingestion, housekeeping. This split out from `docs/domains/customer-intelligence.md` (2026-05-20) — the customer-intelligence runbook now covers leveling/scoring/wealth; this one covers everything Mailchimp-driven plus the lead pipeline.

## Daily orchestrator

Single entry point: `POST /api/automations/mailchimp-sync` (runs 4 phases). Cron: `scripts/auto-mailchimp-sync.sh` daily (Synology Task Scheduler, Bearer `AUTO_IMPORT_API_KEY`).

Phases:

1. **campaigns** — pull metadata for every campaign (subject, send time, audience id)
2. **metrics** — pull aggregate metrics (opens, clicks, bounces) for campaigns sent in the last 30 days
3. **activity** — pull per-email member activity (opens, clicks) for the last 14 days
4. **ingest-leads** — convert qualifying `MailchimpActivity` rows into `Lead` rows

Pass `?phase=campaigns|metrics|activity|ingest-leads` to run one phase. No param = run all four.

All runs log to `MailchimpSyncLog` (kind = `mailchimp-sync` for full, `mailchimp-sync:<phase>` for single-phase). Health endpoint flags last-success as stale after 36 hours.

Admin UI: `/admin/automations/mailchimp-sync` — "Run All Steps" plus four individual phase buttons. Per-button endpoints under `/api/mailchimp/*` still work for one-off needs.

## Models

| Model | Purpose |
|---|---|
| `MailchimpCampaign` | Campaign metadata (subject, send time, audience id, send count) |
| `MailchimpCampaignStats` | Aggregate metrics (opens, clicks, bounces, unsubscribes) |
| `MailchimpActivity` | Per-email engagement event (member id + email + campaign id + type + timestamp) |
| `MailchimpSyncLog` | Audit log of sync runs |
| `Lead` | Sales-qualified follow-up record (status, assignee, pinned flag, lastActionAt) |

## Audience sync

`lib/mailchimpAudienceSync.ts` — keeps the Mailchimp audience in sync with Customer rows. Pure helper `buildMemberPayload({email, firstName, lastName, tags})` validates the email (rejects empty / staff / malformed) and returns the Mailchimp API payload shape.

Tests pin the validation cases (`__tests__/mailchimpAudienceSync.test.ts`). Real-DB integration: `__tests__/integration/mailchimpAudienceSync.runner.integration.test.ts`.

## Auto-lead ingestion (the conversion step)

`lib/mailchimpLeadIngestor.ts`. Converts new `MailchimpActivity` rows into `Lead` rows. Rules:

| Activity type | Qualifies as a lead? |
|---|---|
| Click | **Always** |
| Open | Only if the customer is high-value: peak level ≥ 3 OR wealth tier HIGH/VERY_HIGH/ULTRA_HIGH |
| Bounce / unsubscribe | Never |

**Dedup by email + active status** — if an ACTIVE lead (NEW/ASSIGNED/CONTACTED) already exists for the email, just bump `lastActionAt` instead of creating a duplicate.

**Auto-assign** to `Customer.primaryDesignerId` when present → lead status jumps to `ASSIGNED`. Otherwise stays `NEW` for manager triage.

Real-DB integration: `__tests__/integration/mailchimpLeadIngestor.integration.test.ts`.

## Lead aging + housekeeping

`lib/leadHousekeeping.ts`. Nightly job (`/api/automations/lead-housekeeping`, cron `scripts/auto-lead-housekeeping.sh` daily at 05:00):

- **Auto-archive** NEW/ASSIGNED leads untouched for 30 days (`ARCHIVE_AFTER_DAYS`). Sets status=LOST + archivedBy="auto".
- **Exemptions**: `pinned=true` (manager-set), OR the lead's customer has an active QUOTE.
- **14–29 days without action** = "going stale" — yellow card strip in UI, NOT archived.

`Lead.lastActionAt` bumps on any meaningful edit: status change, assignment, note, OR a new MailchimpActivity for the email.

Real-DB integration: `__tests__/integration/leadHousekeeping.integration.test.ts` (per CLAUDE.md notes).

## Campaign Attribution report

`/reports/mailchimp` (admin/marketing only). Pure engine: `lib/campaignAttribution.ts` (20 unit tests).

Ranks campaigns by attributed revenue within a 30-day window from open/click. Two key knobs on `AttributionOptions`:

| Option | Default | Effect |
|---|---|---|
| `mode: "last-touch"` | **default** | Each purchase credited to the single most recent engagement within window. Summed revenue across campaigns equals true sales — no double-counting. |
| `mode: "shared"` | opt-in | Per-campaign non-exclusive credit. Useful for conversion-rate comparisons. |
| `excludeNewCustomerDays: 60` | **60 days** | Drop any customer whose `Customer.firstOrderDate` falls inside the 60 days before a campaign's first engagement. Walk-ins added to the list on their first purchase would otherwise inflate the next campaign's numbers. |

Both endpoints (`/api/mailchimp/campaigns/db` list, `/api/mailchimp/campaigns/[id]` detail) pull engagements + orders + `Customer.firstOrderDate` in parallel. Detail pulls cross-campaign engagements for engaged customers so last-touch resolves identically to the list.

**Respects** CLAUDE.md rule 33 (cancelled line items excluded) and the netPrice invariant (no qty multiplication).

## CRITICAL: revenue queries MUST include `RETURNED` in the status filter

Per CLAUDE.md gotcha + post-failure 2026-05-13. Any aggregation that asks "what did this customer / campaign / segment / dept actually generate in net revenue?" must filter `status: { in: ["ORDER", "FULFILLED", "RETURNED"] }`. Use the canonical `SALES_REVENUE_STATUSES` from `lib/salesOrderRevenue.ts`.

The negative netPrice rows on RETURNED orders (accounting returns) are HOW returns + rewrites net out. Drop them and you double-count every rewritten sale by the full base amount.

Source-text tripwire: `__tests__/reports.salesRevenueStatusFilter.test.ts`.

Real-DB integration: `__tests__/integration/mailchimpAttributionRewriteChain.integration.test.ts` — pins the exact net math for base + return + rewrite chains.

User-reported origin: Barbara Germano report showed $88,624 attributed when her real net spend was $61,922. Five surfaces were patched in PR #246 (Mailchimp list + detail, Wealth Insights, three `customerLeveling.ts` SQL sites).

After deploying any fix that touches revenue aggregation, run `POST /api/customers/recalculate-levels` once so `Customer.lifetimeSpend` catches up.

## Leads board

`/leads` (manager-facing). API returns:

| Field | Visibility |
|---|---|
| `leadTier` (🔥 HOT / 🙂 WARM / 🙃 COOL / 😐 NEW) | All roles |
| `leadScore` numeric | ADMIN/MANAGER/MARKETING only |
| `wealthTier` | ADMIN/MARKETING only (NOT MANAGER) |
| `recentEngagement` (last open/click + 30-day campaign count) | All roles |
| `suggestedAction` hint per card | All roles |

**Manager-only "Needs Attention" strip** at the top via `GET /api/leads/needs-attention` — counts for new-to-assign / going-stale / hot-no-contact.

**Pin toggle** on any card to exempt from auto-archive.

## Manual sync endpoints (one-offs)

| Endpoint | Use case |
|---|---|
| `/api/mailchimp/sync.ts` | Full pipeline (legacy, prefer the orchestrator) |
| `/api/mailchimp/sync-activity.ts` | Just activity window |
| `/api/mailchimp/sync-all-activity.ts` | Wider activity backfill (slow) |
| `/api/mailchimp/sync-metrics.ts` | Just metrics window |
| `/api/mailchimp/backfill-customer-links.ts` | Re-link `MailchimpActivity.customerId` for rows that didn't match on first ingest |
| `/api/mailchimp/delete-all.ts` | Nuke + re-sync (ADMIN, dangerous) |

## Verification checklist (before touching Mailchimp code)

- [ ] Read this runbook + `docs/domains/customer-intelligence.md` (leveling + lead scoring depend on it)
- [ ] Any new revenue aggregation imports `SALES_REVENUE_STATUSES` from `lib/salesOrderRevenue.ts`
- [ ] Wealth fields stripped server-side from non-ADMIN/MARKETING responses (page-level filtering alone is insufficient — see `docs/domains/staff-auth.md` "Wealth Data Visibility")
- [ ] If touching attribution math, the rewrite-chain integration test must still pass
- [ ] Any new lead-creating path uses the `Lead.lastActionAt` bump pattern so housekeeping doesn't archive active follow-ups

## Test coverage

| Surface | Coverage |
|---|---|
| `campaignAttribution.ts` | 20 unit tests pinning last-touch vs shared math + edge cases |
| `mailchimpAudienceSync.ts` | Unit + real-DB integration |
| `mailchimpLeadIngestor.ts` | Real-DB integration |
| `leadHousekeeping.ts` | Real-DB integration |
| Revenue-status filter | Source-text tripwire + real-DB attribution test |
| Sync runners | Real-DB integration (`mailchimpAudienceSync.runner.integration.test.ts`) |

## Known gaps

- Mailchimp impact report separation from Wealth Insights (GitHub #187, ROADMAP)
- No backfill for Mailchimp campaigns sent BEFORE the Mailchimp account migrated
- Lead `assignedTo` doesn't currently support multiple designers (e.g., for couples-team-handle)

---
Last verified: 2026-05-20
