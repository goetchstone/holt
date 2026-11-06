# Automations

Everything Holt does by itself, and how a store controls it. It's GAP-37; the reasoning is
DECISIONS 48. Owner, 2026-11-06: "Any automation should be something the user can configure."

Source read for this runbook: `lib/automations/catalog.ts`, `schedule.ts`, `settings.ts`,
`jobs.ts`, `runner.ts`, `screen.ts`, `pages/api/automations/tick.ts`,
`pages/api/admin/automations/[key].ts`, `scripts/install-cron.sh` (2026-11-06).

## How it works

A host's scheduler does one thing: every 5 minutes, `scripts/auto-automations.sh` calls
`POST /api/automations/tick`. Holt then runs whatever's switched on and due, going by the store's
settings. So a store never touches a server's schedule, and the host never decides what runs.

**Admin › Automations** (`admin.automations`) shows each one: on or off, when, how it last went,
and Run now, which runs it whatever its setting says. It warns if nothing has woken Holt in 15
minutes.

| Automation | Starts as | Why that default |
|---|---|---|
| Send waiting emails and texts | On, every 5 minutes | Off means no email at all, password resets included |
| Release expired quote holds | On, hourly | Otherwise an untouched quote keeps its stock |
| Clear abandoned card checkouts | On, hourly | Otherwise they read as pending and can block a new link |
| Daily reconciliation | On, 10 PM | Keeps the books checked |
| Customer balance check | On, 4 AM | Keeps the books checked |
| Customer levels and lifetime spend | On, Sundays 4 AM | Suggested clients depend on it |
| Archive stale leads | Off, 5 AM | Changes data a store may want left alone |
| Daily POS import | Off, 6 AM | Needs an outside system |
| Door counter traffic | Off, 2 AM | Needs an outside system |
| Mailchimp campaign results | Off, 5 AM | Needs an outside system |
| Add new customers to Mailchimp | Off, 6 AM | Needs an outside system |

**Not on the list, on purpose:**

- **The morning email, low stock list and customer messages** have settings of their own, and go
  out through "Send waiting emails and texts". The screen links to them and shows their state, so
  each fact keeps one home (rule 6). It links to how all of them look and read too, at Admin › Setup
  › Email look and wording (`docs/domains/email.md`).
- **Database and upload backups** stay in the host's cron (`scripts/install-cron.sh`). They run
  outside the app, on the server's files, and shouldn't depend on the app being up.

## When something is due

Times are the store's own (`AppSettings.timezone`), through clock changes too. A job is due when a
scheduled moment has passed since it last started or was switched on, whichever is later. So:

- Switching on a 4 AM job at 2 PM waits for the next 4 AM.
- A server that was down at 4 AM catches up when it next wakes, once.
- Every-few-minutes jobs count from their last start, allowing 30 seconds for a wake-up being early.

Hours are whole. The old cron lines had a few half-past times, which were rounded down.

## Running and failing

- **One at a time.** A job starts by moving `lastStartedAt` on from the value it read, which only
  one caller can do. So two wake-ups, or a wake-up and Run now, can't run it twice.
- **A long job doesn't hold up the rest.** The next wake-up claims whatever's due and isn't running.
- **A job that says RUNNING for over 2 hours** is taken to have died with its server.
- **A failure reaches someone (rule 65):** the screen shows it, and it goes to ops alerts. The tick
  still answers 200, since a retry from cron would only run the job again.
- **Not set up yet:** a job that needs an outside system records `SKIPPED` with what's missing, with
  no alert. A store chose to switch it on, so the screen says what it still needs.
- **A day with drift** is `OK`, with the count in its summary. It finished, and the day's page has
  the detail. An empty day shows as drift, since it has no journal entry to compare.

## The routes stay

`pages/api/automations/*` still run each job by hand, from the admin pages or with the service key.
They and the scheduler call the same functions, moved out of the routes for that reason
(`lib/dailyReconciliationRun.ts`, `lib/mailchimpSyncRun.ts`, `lib/trafficSyncRun.ts`,
`lib/email/queueCycle.ts`, `lib/automations/loggedRuns.ts`).

## Adding one

1. Add it to `AUTOMATION_KEYS` and `AUTOMATION_CATALOG` in `lib/automations/catalog.ts`, with what it
   does, what happens while it's off, and a default: on only if skipping it would quietly hurt the
   books, stock or email.
2. Add what it runs to `AUTOMATION_JOBS` in `lib/automations/jobs.ts`, with a one-line summary, and
   `notReady` if it needs something set up first.
3. No new cron line. `__tests__/automationCatalog.test.ts` fails on a new route under
   `pages/api/automations` until it's in the catalog, or says there why it isn't.

## Upgrading a host

Run `scripts/install-cron.sh` once. It rewrites its whole managed block, so the old per-job lines
go. Until then the old scripts are gone, so those lines fail and nothing runs, and the screen shows
the warning.

## Not done

- **Who gets a failure alert** is the deployment's `OPS_ALERT_*` setting, not something a store sets
  on this screen.
- **Run history** is the last run only here. Jobs with a history keep it on their own pages, linked
  from the screen.
- **Minutes** can't be chosen for a daily job, only the hour.
