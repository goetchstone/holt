# Source adapters

A **source system** is whatever a deployment ran before holt and keeps running
alongside it: a legacy POS, an ERP, a spreadsheet someone emails every morning.
holt pulls from it on a schedule and writes the results into its own models.

A deployment picks one in **Settings → Configuration → Source System**. The
shipped default is **No source system**, and that is a real answer — a business
that keys everything in holt imports nothing.

## Why the seam exists

`lib/adapters/ordorite/` was swappable in *practice*: one entry point, one
production call site. But there was no type saying so, no registry, and nothing
a second adapter could implement. "Replaceable" was a property you could verify
only by reading 5,000 lines and noticing nothing else imported them. That is a
coincidence, not a seam.

Worse, "no source system" was unrepresentable. A deployment that had never
heard of Ordorite still got its import route, its admin page and its failure
modes, and "we key everything natively" looked exactly like "Ordorite,
misconfigured."

## The interface

`lib/adapters/types.ts`:

| Member | Purpose |
| --- | --- |
| `id` | Stable. Persisted in `AppSettings.sourceAdapterId` — renaming is a migration. |
| `label`, `description` | What an operator sees in the picker. |
| `moduleFlag` | Feature flag this adapter needs, or `null`. Keeps existing per-edition gating; does not add a second switch. |
| `checkReadiness()` | Can it run right now? **Never throws.** |
| `runImport({dryRun, createdBy})` | Pull what is waiting and import it. May throw; the caller alerts. |

The shape deliberately mirrors `lib/payments/` (`PaymentProvider` + a flat
registry with a lookup). One difference: a payment needs two questions answered
separately — who should take a *new* payment, versus who took *this* one, since
a refund must return through the processor that captured it. An import has no
such history; rows already imported are holt's rows, and nothing routes back.
So there is one question here, `getActiveSourceAdapter()`, and adding a second
would be a smell.

## Adding one

1. Implement `SourceAdapter` under `lib/adapters/<yours>/`.
2. Add it to the `ADAPTERS` array in `lib/adapters/index.ts`.

That is the whole cost, and it is the claim this module exists to make true.
`__tests__/sourceAdapters.test.ts` asserts every registered adapter satisfies
the interface, so a new one is covered the moment it is registered.

## What an adapter owns

**Transport and translation**: how to reach the source, how to recognise what it
sent, how to turn that into holt rows.

**Not holt's domain rules.** When source semantics leak past the boundary — a
stock-location naming convention read by allocation code, a rewrite-chain notion
baked into commission — that is the bug CLAUDE.md rule 61 names, and the fix is
to move the fact behind the line, not to widen the interface.

`__tests__/sourceAdapterSeam.test.ts` is a source-text tripwire: nothing outside
`lib/adapters/` may import an adapter's internals, and the import route must
resolve through the registry rather than naming an adapter. The one allowed
exception is `lib/testing/withTestDb.ts`, which clears the adapter's
module-level caches after a TRUNCATE — test plumbing reaching into
implementation on purpose.

## Resolution rules

| Situation | Result | Why |
| --- | --- | --- |
| Configured, module on | that adapter | — |
| Configured, module **off** | `none` | Turning a module off is how an operator disables a feature; a nightly cron should not start throwing. The selection stays in `AppSettings`, so re-enabling restores it. |
| Id not in this build | **throws** | Wrong image or a botched rename. Importing nothing while reporting success is how reports go stale with nobody told. |

## Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/automations/source-import` | POST | Run the import. Bearer `AUTO_IMPORT_API_KEY` (cron) or an ADMIN session. |
| `/api/automations/source-readiness` | GET | Is it configured? ADMIN only — the reason names integration settings. |
| `/api/automations/gmail-import` | POST | **Deprecated alias.** Forwards to `source-import`. |

The alias exists because a deployed Synology cron calls that exact path.
Renaming a URL a cron hits at 06:10 is how a nightly import dies silently for a
week. Remove it once every deployment's crontab has been repointed — a
coordination step, not a code change.

`source-import` returns **409 with the missing setting named** when the adapter
is not ready, instead of a 500 from four frames inside a Google auth client.

## Shipped adapters

| Id | What it connects to |
| --- | --- |
| `none` | Nothing. Scheduled imports are a no-op that says so. |
| `ordorite` | Polls a Gmail mailbox for the CSV reports Ordorite emails, routes each attachment by filename, imports it. Needs the `legacyPosImport` module. |

## Migration note

`20260806180000_app_settings_source_adapter` backfills `sourceAdapterId =
'ordorite'` wherever the `legacyPosImport` module is enabled. That flag is what
gated the old import route, so carrying it across is the guarantee an existing
deployment's nightly import keeps running — without it, the cron would start
reporting "nothing to import" and every report would quietly go stale.
