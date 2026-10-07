# Up-Board — Staff Rotation

The "who's next to help a walk-in customer" board. One per store location, independent of each other. Designed for high-traffic floor staff who clock in at the front desk and rotate through customer assignments.

This is operationally distinct from time-clock or payroll — those use a separate `StaffShift` lifecycle for compliance, but `StaffShift` IS the model the up-board reads from.

## Models

| Model | Purpose |
|---|---|
| `StaffShift` | One row per (staff, clock-in, clock-out) session. `clockOut: null` = currently on the board. |
| `UpBoardEntry` | Order on the board for a specific store location. Position-indexed. |
| `StaffMember` | The person; tied to `User` via `userId` when they've logged in |

## Status model

`UpBoardEntry.status` is a `UpBoardStatus` enum (verified against schema 2026-05-20):

| Status | Meaning |
|---|---|
| `UP` | Next in line to take a customer |
| `WITH_CUSTOMER` | Currently helping a customer |
| `ON_BREAK` | Temporarily unavailable |
| `AVAILABLE` | In rotation but not next |

Default on insert is `AVAILABLE`. Exactly one entry per store should be `UP` at a time; the helper `promoteNextUp(storeLocation)` finds the lowest-position AVAILABLE entry and promotes it.

## Lifecycle

| Event | Effect |
|---|---|
| **Clock in** (`POST /api/upboard/clock-in`) | Creates `StaffShift` with `clockIn = now`, `clockOut = null`. Appends an `UpBoardEntry` at the bottom of that store's board (status `AVAILABLE`). |
| **Clock out** (`POST /api/upboard/clock-out`) | Sets `clockOut = now` on the open `StaffShift`. Removes the `UpBoardEntry`. |
| **Auto-expire (9h)** | Any open shift older than 9 hours has `clockOut` auto-set to `now` on the next board read. See `expireStaleShifts()`. After expiring, `compactAndPromote(store)` runs for each affected store. |

`compactAndPromote(storeLocation)` (verified 2026-05-20):

1. Fetches all `UpBoardEntry` rows for the store, sorted by position
2. Re-numbers positions sequentially (1..N) — removes gaps left by clock-outs
3. Ensures exactly one entry is `UP` — promotes the first AVAILABLE entry if nobody is currently UP

**Concurrency caveat**: `compactAndPromote` does NOT run inside a `prisma.$transaction` — it iterates and updates row-by-row. Concurrent clock-ins or actions could interleave with the renumber loop. The position scheme is forgiving enough that race-induced gaps self-heal on the next board read, but the invariant "exactly one UP per store" is a soft check, not a hard SQL constraint.

## Per-store independence

Each `StoreLocation` has its own board. `GET /api/upboard/[store]` returns just that store's queue. Cross-store visibility doesn't exist — Main Showroom front desk shouldn't see West Showroom's queue.

## 9-hour auto-expire

`lib/upboard.ts:expireStaleShifts()` runs on every board read (no cron job). A staff member who forgets to clock out by close of day is auto-clocked-out at 9 hours past clock-in. Prevents stale entries from cluttering the next morning's board.

This is deliberately lazy (read-triggered, not scheduled) so we don't need a cron job and don't need to think about timezones.

## Dashboard widget

`components/dashboard/UpBoardWidget.tsx` — manager dashboard surface. Shows all stores' boards side-by-side. Refreshes every 30s via polling. Click-through to the full per-store view at `/upboard/[store]`.

## Action types

`POST /api/upboard/action` with `{ staffMemberId, action, customerNote? }` — verified against source 2026-05-20:

| Action string | Effect |
|---|---|
| `take_customer` | Person currently at status `UP` transitions to `WITH_CUSTOMER`. `promoteNextUp(store)` then advances the next AVAILABLE person to UP. |
| `finish_customer` | Person at `WITH_CUSTOMER` returns to the bottom of rotation as `AVAILABLE`. |
| `go_on_break` | Person moves to `ON_BREAK` (removed from rotation temporarily). |
| `return_from_break` | Person returns to bottom of rotation as `AVAILABLE`. |

The handler explicitly rejects unknown action strings with a 400 listing the four valid values.

`customerNote` is an optional free-text annotation captured alongside the `take_customer` transition for downstream interaction-logging.

## Verification checklist (before touching up-board code)

- [ ] Per-store independence preserved — never cross-pollinate boards
- [ ] `expireStaleShifts()` called from any board-read path (`GET /api/upboard/[store]`)
- [ ] `promoteNextUp()` invariant: exactly one entry per store at status `UP` at any time (soft — see concurrency caveat above)
- [ ] New action strings added to the handler ALSO added to the rejection error message AND this runbook

## Test coverage

**Gap noted in `docs/domains/staff-auth.md`**: `upboard.ts` is Prisma-dependent and not covered by unit tests. The proper fix is real-DB integration tests under `__tests__/integration/upboard.integration.test.ts` covering:

- Clock-in → entry appears at bottom
- ASSIGN → top moves to bottom
- 9-hour expire happens on next board read
- compactAndPromote() closes position gaps
- Two stores' boards stay independent under concurrent clock-ins

**Not yet written** — tracked as future work.

## Known gaps

- No mobile-specific view — designers on iPad see the same UI as desktop managers
- No "who served whom" historical report — useful for performance analysis but not built
- No fairness-rule customization — round-robin is hard-coded
- No integration with up-coming Lead Score notifications (a HOT lead walking in could surface a hint about which designer's specialty matches)

---
Last verified: 2026-05-20
