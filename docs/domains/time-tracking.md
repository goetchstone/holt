# Time Tracking

Billable / non-billable time logging ported from the upstream RMS codebase into Holt's idiom.
Gated by the `timeTracking` feature flag (`lib/featureCatalog.ts`, default
**off** — it's a niche module). Nav item "Time" appears for
SUPER_ADMIN/ADMIN/MANAGER/DESIGNER when enabled.

## Data model

**TimeEntry** (`prisma/schema.prisma`, migration `20260603215543_add_time_entries`):

- `organizationId`, `staffMemberId` (who logged), optional `customerId`.
- `description`, `minutes` (integer), `date` (`@db.Date`), `isBillable`.
- `billedAt` (`DateTime?`) — the entry's billed lifecycle stamp.

### Why `billedAt`, not an Invoice FK

The upstream RMS linked `TimeEntry.invoiceId` to its invoice model. Holt's `Invoice`
is the **sales** invoice (line items, payments, tax), not a service
invoice — mapping tracked hours onto it doesn't fit. So this port uses a
decoupled `billedAt` timestamp ("has this been billed?") instead of a hard FK.
A real invoice link can be added later if a service-billing flow lands. This is
the simplest correct shape (CLAUDE.md rule 18), not a gap.

## Helpers (`lib/timeEntries/`)

- `duration.ts` — `parseDurationToMinutes(input)` accepts `90`, `45m`, `1.5h`,
  `1h30m`, `1h 30m`, `1:30`; rejects empty/junk/zero/over-24h. `formatMinutes`
  renders minutes as `1h 30m`. Pure, tested. The **client** parses the shorthand
  before posting; the API validates the resulting integer minutes.
- `summary.ts` — `summarizeTimeEntries(entries)` → total / billable /
  unbilled-billable minutes + count. Pure, tested.
- `requestBody.ts` — zod parsers `parseTimeEntryCreateInput` /
  `parseTimeEntryUpdateInput` (≥1 field).

Tests: `__tests__/timeEntryDuration.test.ts`, `timeEntrySummary.test.ts`,
`timeEntryRequestBody.test.ts`.

## API (`pages/api/time-entries/`)

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/time-entries` | GET | any staff | Own entries; ADMIN/MANAGER/SUPER_ADMIN add `?all=true` or `?staffMemberId=`; `?from`/`?to`/`?customerId` filters |
| `/api/time-entries` | POST | any staff | Log time; only privileged users may set `staffMemberId` for someone else |
| `/api/time-entries/[id]` | PATCH | owner or privileged | Edit fields; `billed` toggles `billedAt` |
| `/api/time-entries/[id]` | DELETE | owner or privileged | Remove an entry |

Privileged = SUPER_ADMIN / ADMIN / MANAGER. Non-staff users get 403 ("Only
staff can track time").

## UI

- `app/(dashboard)/app/time/page.tsx` resolves the privileged flag from
  `requirePage` and passes `canSeeAll` to the client view.
- `TimeTrackingView.tsx` — inline log form (description, shorthand duration,
  date, billable, optional customer typeahead over `/api/customers`), a totals
  strip (total / billable / unbilled), a Mine/Team toggle for privileged users,
  and a table with one-click Billed/Unbilled toggle + delete.

## Verification checklist

- [ ] `npm run validate` clean; lib unit tests pass.
- [ ] Logging "1h30m" stores 90 minutes.
- [ ] A non-privileged user only sees + edits their own entries.
- [ ] Billed toggle sets/clears `billedAt`; totals reflect it.
- [ ] With `timeTracking` off: nav hidden, `/app/time` redirects home.
