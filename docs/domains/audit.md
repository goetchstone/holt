# Audit trail

Who did what across the store, on one screen. It's GAP-29; the reasoning is DECISIONS 50.

Source read for this runbook: `lib/audit.ts`, `lib/auditCatalog.ts`, `lib/auditFeed.ts`,
`app/(dashboard)/app/admin/audit/*`, `__tests__/auditCoverage.test.ts` (2026-11-06).

## What a store sees

**Admin › Audit Trail** (`admin.audit`, which only the owner and administrators start with). Newest
first, filtered by who, what kind of thing, and dates in the store's time. Nothing on it can be edited.

## Where each fact lives

`lib/auditFeed.ts` reads every history below and merges them. No fact is copied into a second place
(rule 6).

| What | Where it's recorded |
|---|---|
| Order changes, discount approvals, refunds, voided payments | `OrderChangeLog` |
| Gift card movements | `GiftCardTransaction` |
| Store credit | `CustomerCreditTransaction` |
| Commission payout edits | `CommissionPayoutEdit` |
| Stock moved by a person | `StockMovement` |
| Configuration presets | `ConfigChangeLog` |
| Everything else in `lib/auditCatalog.ts` | `AuditEntry` |

**`AuditEntry` holds no foreign keys**, so an entry outlives what it describes. Deleting an order removes
the order's own history with it, and its entry is what's left.

## Recording something new

1. If it has a history of its own, write it there, and add the source to `lib/auditFeed.ts` if it's new.
2. Otherwise add the event to `lib/auditCatalog.ts` and call `auditLog(event, actor, facts)`.
3. **Inside a transaction, pass it.** The entry then stands or falls with the action, so the action can't
   happen unrecorded. Outside one, the action has already happened, so a failed write is logged and
   doesn't fail it.

`__tests__/auditCoverage.test.ts` is the tripwire (rule 65). It fails on:

- an event nothing records
- a route of a sensitive shape that records nothing, unless it says why not
- a stated reason that's gone stale

The shapes are bulk deletes and clears, merges, price imports, roles, staff, tax, payment types, database
operations, exports, settings, integration keys, impersonation, automations and commission plans.

## What it never holds

Passwords, PINs, integration key values or a gift card's barcode, since a barcode spends the card. Settings
are recorded by field name, not value, and integration keys by provider and field.

## Not done

- **Before and after for settings.** Field names say what changed, not to what. Prices and access changes
  do say.
- **What the system does by itself**, like a webhook marking a payment failed or an order's stock being
  committed. This trail is about people.
- **A database restore replaces the trail** with the one in the backup, then records the restore itself.
  The log line for its start is in the application log.
- **Keeping it forever is the only option.** There's no retention setting.
- **Deleting an order with a taken payment answers a generic "Failed to delete order".** A database trigger
  refuses it, and nothing is deleted or recorded. In `ROADMAP.md`.
