# External Integrations

Catch-all runbook for external integrations not covered by their own domain doc. The major ones — the POS (`import-pipeline.md`), Mailchimp (`mailchimp.md`), Google Gmail (in `import-pipeline.md`), Stripe (in `pos.md`), GitHub Issues (`feedback.md`) — have their own runbooks. This is the rest.

## Axper — store traffic data

**Purpose**: count of people walking into each store, per 15-minute interval, per day. Feeds the manager dashboard's traffic widgets AND (since 2026-05-28) persists into `TrafficSnapshot` so reports can roll up date ranges without re-pulling from Axper on every page load.

**Two paths** (intentional split):

| Path | When | File |
|---|---|---|
| **Live pull** | Dashboard charts displaying TODAY (cron hasn't run for it yet) | `GET /api/axper/traffic?dateFrom&dateTo` → `lib/axperClient.ts:fetchAxperTraffic` |
| **Persisted history** | Reports + dashboards displaying YESTERDAY-and-earlier | DB read from `TrafficSnapshot` |

The two share the same `lib/axperClient.ts` for the actual HTTP call. The on-demand endpoint and the cron orchestrator both go through that one client so the URL + credential live in one spot.

**Persistence**:

- Model: `TrafficSnapshot` — one row per (15-min interval × Axper store × day). Fields: `intervalStart` (DateTime, store-local), `axperStoreName` (raw Axper value), `storeLocationId` (FK, nullable when unmapped), `visitors` (= Axper `entries`), `exits` (nullable).
- Unique key: `(intervalStart, axperStoreName)` → the cron upserts idempotently. Re-running the same day is a no-op.
- 3 stores × ~36 intervals/day × 365 days = ~40k rows/year. Small.
- Audit: `TrafficSyncLog` — one row per cron / Run-Now invocation with counters (rowsFetched/Inserted/Updated, daysScanned, daysBackfilled, errors, triggeredBy).

**Cron**:

- Endpoint: `POST /api/automations/axper-traffic-sync` (Bearer `AUTO_IMPORT_API_KEY` OR NextAuth session).
- Synology Task Scheduler runs `scripts/auto-axper-traffic.sh` at **02:00 ET** daily (after Axper closes the previous day).
- Behavior: pull yesterday + auto-backfill any day in the last 30 with zero existing rows. Configurable via `{"backfillWindowDays": N}` body (max 800).
- **Async by design** (2026-05-28): the POST creates a `TrafficSyncLog` row with `finishedAt = null` and returns `202 { logId, status: "running", backfillWindowDays }` IMMEDIATELY. The Axper fan-out runs in the background after the response is sent. The admin UI polls `/api/admin/automations/axper-traffic/recent` every 5s for the matching log row's `finishedAt`. Without this the 2-year backfill (730 days × ~1s/call) hit nginx's 300s upstream timeout and 504'd. Cron `curl -sf` accepts the new 202 the same as 200 — script logs now show the `{logId,status}` payload instead of the full result; the actual result lives on the `TrafficSyncLog` row.
- **Crash-recovery gap**: if the Node process dies mid-job, the log row stays with `finishedAt = null` forever. A janitor sweep (spawned task chip; will live on `lib/abandonedTrafficSyncSweep.ts`) marks rows with `startedAt > 1h ago AND finishedAt IS NULL` as abandoned on the next admin-page load.
- Admin UI: `/admin/automations/axper-traffic` for "Run Now" + last 20 runs. The running row shows `running… (Xs)` with a ticking elapsed time; on completion the row gets its duration + result counts.

**Auth**: `AXPER_API_KEY` env var (the Axper API key). Sent as a query param (Axper's API design, not OAuth).

**Store mapping** (`lib/storeColors.ts`):

- `West Showroom` → `West Showroom`
- `MS-A`, `MS-B` → `Main Showroom` (both Axper names refer to the same physical store)
- `North Showroom Highland Ave` → `North Showroom`

When a new Axper store appears that isn't mapped, the import persists it with `storeLocationId = null` and surfaces the Axper name on the admin "Run Now" results so the operator can add the mapping + re-run.

**Gotchas**:

- **One Axper call per day, always**. Axper's `GetTrafficDataUsingDailyPeriod` endpoint returns the correct counts only when `DateFrom === DateTo`. Multi-day calls silently change the aggregation shape and counts come back wrong. `fetchAxperTraffic` in `lib/axperClient.ts` clamps EVERY caller — even when a caller passes a wider range, the client walks the range day-by-day internally and concatenates. Hard cap on the range is 800 days (`MAX_RANGE_DAYS`); over-cap / inverted / unparseable ranges return `[]` and log. Owner direction 2026-05-28; pinned by `__tests__/axperClient.test.ts` ("makes N calls for a multi-day range — never one call with the full range").
- Hard-coded hours: 9 AM – 6 PM. If a store opens earlier or closes later, that data is not retrieved (Axper API parameter). Change in `lib/axperClient.ts` if you want different hours.
- Axper occasionally returns a CSV body even when `FileFormat=json`. The client treats that as "no data" and returns `[]` — the cron's gap-detector will re-fetch the day on the next run. Multi-day loops handle this per-day: one bad day doesn't poison the rest of the range.
- `intervalStart` is stored as the Axper `local_time` value (no TZ suffix). The stores are all `America/New_York`. Reports rendering in the same TZ show the wall-clock the store actually saw.

**Pure helpers** (`lib/trafficSummary.ts`):

- `rollupByDay`, `rollupByStore`, `rollupByDayAndStore` — aggregate `TrafficSnapshot` rows into report-ready shapes. No I/O.
- `rollupByHour` — 24-row zero-filled (0..23) hour-of-day rollup. Hour is taken from `intervalStart.getHours()` (local wall clock).
- `rollupByDayOfWeek` — 7-row zero-filled Sun..Sat rollup using `Date.getDay()`.
- `totalVisitors`, `conversionRate` — KPIs. `conversionRate` returns null on visitors=0 so the UI renders "—" instead of "Infinity%".
- Tested at the boundary cases in `__tests__/trafficSummary.test.ts` (17 unit tests).

**Reports** (`/reports/traffic`):

- Date-range picker (default last 30 days) + store filter (multi-select, default all). Quick-range buttons for 7d / 30d / 90d.
- KPI cards: total visitors, avg/day, busiest day, busiest hour.
- Charts (Chart.js): daily trend line (one series per store), per-store totals bar, day-of-week bar, hour-of-day bar.
- Per-store totals table with share-of-traffic %.
- CSV export at `GET /api/reports/traffic/export?dateFrom&dateTo&stores` — one row per (day × Axper store).
- **Hybrid data source**: historical days read from `TrafficSnapshot`; if the requested range includes today, the page also calls `fetchAxperTraffic` for today (one Axper call, per the day-by-day clamp in `axperClient.ts`) and merges. Surfaces as `liveTodayPulled: true` in the API response + a small UI badge.
- MANAGER+ only. JSON endpoint at `GET /api/reports/traffic?dateFrom&dateTo&stores` returns `{ totals, byDay, byStore, byDayAndStore, byHour, byDayOfWeek }`.

## PBX / pbxact — call logging (ROADMAP only)

**Status**: Roadmap item, NOT yet wired up. Tracked as GitHub Issue #180.

The intent: tie inbound calls (from the pbxact PBX) to customer records so the interactions log auto-populates when staff answer the phone. Would tie into:

- `lib/pbxClient.ts` (does not yet exist)
- `pages/api/pbx/*` (directory does not yet exist — placeholder noted in code-area inventory)
- New `Call` model? Or extend `CustomerInteraction.kind = PHONE_CALL` with raw call duration / recording URL?

This runbook entry exists as a forward-pointer. When the work starts, this section becomes a real subsection.

## FileMaker Data API — legacy sun-setting

**Status**: legacy. Active for a few specific report imports while we finish migrating off FileMaker. Sun-setting end goal: zero FileMaker reads.

**Surface**: `lib/fmApiClient.ts`, `lib/fmSafeMapper.ts`.

**Auth**: session-token flow — POST `/sessions` with basic auth → receive session token → use token on subsequent requests for ~15 minutes → DELETE `/sessions/{id}` to release.

**Env vars**:

| Var | Notes |
|---|---|
| `FM_API_BASE` | FileMaker server URL with database name (e.g. `https://fm.example.com/fmi/data/v1/databases/YourDatabase`) |
| `FM_USERNAME` | API user (NOT a database user — a Data-API-Access privilege set) |
| `FM_PASSWORD` | Password |

**Current uses**:

- `getFmSalesRecords(start, end)` — historical sales pulls used during the initial the POS migration; rarely needed now
- Consignment data backfill (Marjan rugs) — superseded by the POS consignment workflows per `docs/domains/consignment.md`

**Why we keep it**:

- Some historical data (pre-2024) only exists in FileMaker
- The session-token mechanic is brittle (no refresh, no idempotency) — we treat every call as one-shot

**Migration end state**: every FileMaker call becomes either (a) a one-off SQL extraction we run once and store in our Postgres, or (b) replaced by an the POS-native equivalent.

**Don't add new FileMaker reads** without explicit reason. Prefer extending an the POS import.

## Windfall — wealth enrichment

**Surface**: `lib/windfallImport.ts`, `pages/admin/import/windfall.tsx`.

**Format**: CSV import (drag-and-drop in the admin UI). One row per customer, keyed by the POS customer code.

**Cadence**: weekly. Windfall sends the file via email; admin uploads manually.

**Model**: `WindfallEnrichment` — 1:1 with `Customer`. Includes net worth, wealth tier, 20+ lifestyle/asset/philanthropy/political boolean signals, match confidence.

**Visibility**: ADMIN + MARKETING only. NEVER MANAGER (per `docs/domains/staff-auth.md` "Wealth Data Visibility").

**Pricing**: paid service. Stop the import if Windfall's contract ends — historical rows stay valid but don't refresh.

See `docs/domains/customer-intelligence.md` for how Windfall data feeds Lead Score.

## Google services

### Google OAuth (NextAuth)

Auth provider for staff login. Configured in `pages/api/auth/[...nextauth].ts`. Domain-restricted to the company's email domain (configured in the NextAuth callback).

### Google Drive — project folder creation

`pages/tools/create-project.tsx` + `pages/api/google/*` — designers create a project folder under the shared "Customer Projects" drive when they start a new design engagement.

OAuth scopes: `drive.file` (folder creation) — narrow scope, can't read or modify existing files.

### Gmail API — the POS report ingestion

Covered fully in `docs/domains/import-pipeline.md`. Service account with domain-wide delegation; impersonates the configured automation mailbox; reads CSVs from the `Automations` label.

## Verification checklist (before adding/touching an integration)

- [ ] Document the integration here OR in its dedicated runbook before merging code
- [ ] Env vars listed AND tied to `env.example` (or `.env.local` template)
- [ ] Failure mode documented (what happens when the external service is down)
- [ ] Auth/credential rotation path (how to get a new key when the old one is revoked)
- [ ] Idempotency story (re-runs of the same import must not double-count)

## Known gaps

- **PBX integration** — entire roadmap item (#180)
- **FileMaker** — no migration deadline; treat as sun-setting forever-pending
- **No outbound webhooks** — we receive from Stripe + GitHub but don't send to anyone
- **No SMS provider** — portal links + reminders go manually
- **No QuickBooks Online API** — accounting export is manual CSV/IIF to QB Desktop for Mac (per `docs/domains/accounting.md`)

---
Last verified: 2026-05-20
