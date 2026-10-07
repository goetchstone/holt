# Scheduling (Service catalog + availability)

Upgrades the Phase-1 flat-hours booking into a config-driven scheduling system
ported from the upstream RMS codebase (Service / StaffAvailability / CalendarBlock) into
Holt's idiom. **Non-breaking**: when no services + windows are configured the
public booking flow falls back to the flat `AppSettings.bookingConfig` hours, so
existing deployments keep working with zero config. Gated by the existing
`booking` feature flag.

## Data model (migration `20260603220533_add_scheduling`)

- **Service** — a bookable offering: `name`, `slug` (unique per org), `description`,
  `durationMinutes`, `bufferMinutes`, `price?`, `isPublic`, `isActive`, `sortOrder`.
- **AvailabilityWindow** — a weekly recurring window: `dayOfWeek` (0=Sun..6=Sat),
  `startTime`/`endTime` ("HH:MM", org timezone). Optional `serviceId` (null = all
  services) and `staffMemberId` (null = whole business). **MVP UI manages
  org-wide windows**; the per-service / per-staff columns exist for later.
- **CalendarBlock** — one-off time off / closure: `startsAt`, `endsAt`, `reason?`,
  optional `staffMemberId` (null = business-wide closure).
- **Booking** gains optional `serviceId` + `staffMemberId` (keeps `serviceType`
  free-text for the no-catalog flow).

## Engine (`lib/booking/`)

- `slots.ts` — `generateSlots` (flat business hours). **Unchanged**; the fallback.
- `availability.ts` — `computeWindowSlots({ fromDate, windowDays, durationMinutes,
  bufferMinutes, windows, busy })`: for each day in the window, each matching
  weekday window emits starts stepped by `duration + buffer`, dropping past slots
  and any overlapping a busy interval (bookings + blocks). Pure, returns the same
  `Slot[]` as `generateSlots`. Tested in `__tests__/bookingAvailability.test.ts`.
- `scheduling.ts` — shared primitives: `DAY_OF_WEEK_LABELS`, `isValidHHMM`,
  `hhmmToMinutes`, `minutesToHHMM`, `slugify`. Tested.
- `serviceRequestBody.ts` — zod parsers for service / window / block create +
  service update. Tested.

## API

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/services` | GET / POST | ADMIN | List / create services (slug from name) |
| `/api/services/[id]` | PATCH / DELETE | ADMIN | Edit / remove (bookings keep history via SetNull) |
| `/api/services/public` | GET | public | Public+active services for the /book picker |
| `/api/scheduling/windows` | GET / POST | ADMIN | List / add availability windows |
| `/api/scheduling/windows/[id]` | DELETE | ADMIN | Remove a window |
| `/api/scheduling/blocks` | GET / POST | ADMIN | List / add time off |
| `/api/scheduling/blocks/[id]` | DELETE | ADMIN | Remove time off |
| `/api/bookings/availability` | GET | public | `?serviceId` → window slots; else flat. Subtracts bookings + blocks |
| `/api/bookings` | POST | public | Accepts `serviceId`; derives end from the service duration + uses its name as the label |

## UI

- Admin: `app/(dashboard)/app/admin/scheduling/` — Services, Weekly hours, and
  Time off management (one page). Linked from the Admin hub ("Scheduling" card).
- Public: `app/(site)/book/BookingView.tsx` — when services exist, a service
  picker appears first and availability loads per service; with no services it's
  the original flat slot list.

## Verification checklist

- [ ] `npm run validate` clean; engine + requestBody unit tests pass.
- [ ] No services configured → `/book` shows the flat slot list (unchanged).
- [ ] Add a service + a Mon 9–17 window → `/book` shows that service; picking it
      lists Monday slots stepped by the duration.
- [ ] A time-off block removes overlapping slots.
- [ ] Booking a service stores `serviceId` + derives `endsAt` from its duration.

## Not ported yet (tracked)

Per-staff assignment + per-staff calendars (assigning a booking to a specific
staff member and showing each person's availability) — the schema supports it
(`staffMemberId` on windows/blocks/bookings) but the MVP UI is org-wide. Follow-up.
