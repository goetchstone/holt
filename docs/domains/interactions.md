# Customer Interactions — Floor Engagement Tracking

In-store customer engagement log. Captures who helped whom, where, what happened, and whether it converted to a quote / sale / appointment. NOT a generic CRM follow-up scheduler — the model has start/end timestamps for the engagement itself, not a "call them back in 3 days" reminder.

## Model (verified 2026-05-20)

`CustomerInteraction` actual fields:

| Field | Type | Notes |
|---|---|---|
| `staffMemberId` | int | Who took the interaction |
| `customerId` | int? | Optional — walk-ins may not be linked yet |
| `salesOrderId` | int? | Optional link to a sales order created during/from this interaction |
| `storeLocation` | string | Free-text store name |
| `storeLocationId` | int? | FK to `StoreLocation` |
| `source` | string (default `WALK_IN`) | Comment in schema: `WALK_IN, PHONE, EMAIL, APPOINTMENT`. **Not an enum** — free text, but those 4 are the expected values. |
| `outcome` | `InteractionOutcome?` enum | See below |
| `notes` | string? | Free-text notes |
| `startedAt` | DateTime (default now) | When the interaction began |
| `endedAt` | DateTime? | When it closed; null while active |
| `isActive` | bool (default true) | `false` = closed/ended. Indexed `[staffMemberId, isActive]`. |

There is no `kind` enum, no `subject` field, no `nextActionAt`. The "active follow-ups" idea I previously described does not exist in this codebase.

## InteractionOutcome enum

Verified against schema:

| Value | Meaning |
|---|---|
| `BROWSING` | Customer looked around, no quote |
| `QUOTE_STARTED` | Quote created during interaction |
| `SALE_COMPLETED` | Converted to sale during interaction |
| `APPOINTMENT_SET` | Scheduled a follow-up, house call, or measure |
| `SERVICE_CASE` | Created a service case |
| `RETURNED` | Customer returned an item |

Not all interactions need an outcome — the field is nullable. Outcome is typically set on close.

## API

| Endpoint | Verified shape |
|---|---|
| `GET /api/interactions` | List, filterable |
| `GET /api/interactions/active` | **My active interactions** — returns `CustomerInteraction` rows where `staffMemberId = currentStaff AND isActive = true`. Sorted by `startedAt` desc. Includes joined `customer` + `salesOrder`. |
| `GET /api/interactions/[id]` | Detail |
| `POST /api/interactions` | Create |
| `PATCH /api/interactions/[id]` | Update — typically used to set `endedAt` + `outcome` + flip `isActive=false` |

`active` is "open engagements I'm currently in" — a designer who took a customer 20 minutes ago and hasn't closed the row yet sees that row. NOT "things due back to me tomorrow."

## Lead Score interplay

A new `CustomerInteraction` for a customer who has an active `Lead` row should bump `Lead.lastActionAt` — that keeps the lead from being auto-archived by the 30-day housekeeping job (per `docs/domains/mailchimp.md`).

**Status of this hookup**: I previously claimed it exists. Have not verified the call site. **Treat as TODO** until someone confirms the bump fires on every interaction create — could be a real gap if it's not wired.

## UI

| Page | Purpose |
|---|---|
| `/interactions` | List + filter |
| `/interactions/[id]` | Detail / edit / close out |

The list view typically filters to "my open" by default — same shape as `active` endpoint.

## Visibility rules

The `active` endpoint enforces `staffMemberId = current staff` server-side, so a designer can't read another designer's active interactions via that endpoint regardless of what UI hides.

**Cross-staff visibility (full list view)** — needs verification against `pages/api/interactions/index.ts`. The role gating there is documented as ADMIN/MANAGER/MARKETING + own-row-for-designers, but I have not pinned the source-of-truth filter. **Treat as TODO** for the next pass.

## Verification checklist (before touching interactions code)

- [ ] If creating a row, set `startedAt` explicitly OR rely on the default-now (don't pass undefined)
- [ ] Closing an interaction: set `endedAt = now()` AND `isActive = false` AND ideally an `outcome` value
- [ ] If new `source` values get used, add them to the schema comment + this runbook (it's a string today; if the set stabilizes, consider enum-ifying)
- [ ] If a new endpoint reads `CustomerInteraction`, confirm the staff-visibility filter is applied server-side (not just UI-hidden)

## Test coverage

| Surface | Coverage |
|---|---|
| Active endpoint staff-visibility filter | None — **gap**; should be a tripwire ensuring `staffMemberId = current` is in the WHERE clause |
| Open/close lifecycle (set endedAt + isActive) | None |
| Lead.lastActionAt bump on interaction create | **Not verified** — see TODO above |

## Known gaps

- No native "follow-up reminder" workflow — the model doesn't have a `nextActionAt`-style field. If the user wants "call them back tomorrow at 3pm" reminders, that's a new feature (separate model or extend this one).
- No integration with calendar (would need Google Calendar OAuth)
- No call-logging integration with `pages/api/pbx/*` (per ROADMAP #180; PBX integration is roadmap-only today)
- No template / quick-form for common interaction shapes
- Bulk close-out for stale active rows (a designer who forgot to close several interactions ends up with a cluttered "active" list)

## Related

- `docs/domains/mailchimp.md` — lead intake; SHOULD bump on interaction (verify call site)
- `docs/domains/customer-intelligence.md` — customer leveling (interactions don't currently feed level)
- `docs/domains/staff-auth.md` — role visibility model
- `docs/domains/upboard.md` — the `take_customer` action carries a `customerNote` that ties into interaction-logging — verify whether it auto-creates an interaction row

---
Last verified: 2026-05-20 (model + active endpoint pinned against source; visibility rules + lead-bump hookup are TODO)
