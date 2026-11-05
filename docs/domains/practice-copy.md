# Practice copy (training mode)

A separate Holt where staff learn the system on the store's real products. Sales, payments
and stock changes land in its own database, no card is charged and no message goes out.
It's GAP-28; the reasoning is DECISIONS 47.

Source read for this runbook: `lib/practiceCopy.ts`, `lib/practiceCopyDatabase.ts`,
`pages/api/admin/database/practice.ts`, `lib/integrationCredentials.ts`,
`prisma/seed/demo/staff.ts`, `docker-compose.yml` (2026-11-05).

## What makes a copy practice

**Its database's name.** `isPracticeCopy()` is true when the database in `DATABASE_URL` has
`practice` as a whole word (`holt_demo_practice`). `holt-practice`, `practices` and
`impractice` aren't. There's no env var or setting to get wrong, and the banner, every guard
and Start over all ask that one function.

A database named as practice stays quiet whatever's loaded into it, even a live backup. A
live database can't be started over.

## Setting one up

The default name, `holt_demo_practice`, carries `demo` too, so the seed's own guard allows it
(rule 59). Any other name needs both words or `--force-unsafe-db`.

1. In `.env`, set `PRACTICE_NEXTAUTH_URL` (where staff will reach it),
   `PRACTICE_NEXTAUTH_SECRET` and `PRACTICE_STAFF_PASSWORD`. See `env.example`.
2. Load the demo seed:

   ```bash
   docker compose --profile practice-seed run --rm practice-seed
   ```

3. Start it, on port 3002:

   ```bash
   docker compose --profile practice up -d --build app-practice
   ```

4. Sign in as `admin@example.com` with `PRACTICE_STAFF_PASSWORD`. Load the store's products
   at Admin › Import › Import Data, or through its usual importers.
5. At Admin › Setup › Database Backup, press **Save as the starting point**.

Staff sign in with the seed's accounts (`designer1@example.com` and so on, in
`docs/domains/seed-data.md`) and `PRACTICE_STAFF_PASSWORD`.

**Give it its own web address.** Browsers share cookies across ports on one host, so a
practice copy and the live app on the same host would keep signing each other out.

### Two settings that protect the live store

- **`PRACTICE_NEXTAUTH_SECRET` must differ from the live secret.** Anyone may be an admin on
  a practice copy. With the same secret, a session signed there is valid on the live app.
  Left unset, the app refuses to start (`lib/validateEnv.ts`). Holt can't compare it with the
  live one, so choosing a different value is on whoever sets this up.
- **The seed refuses the demo password.** A practice copy holds real products and costs, and
  the demo password is in this public repo, so seeding stops before writing anything until
  `PRACTICE_STAFF_PASSWORD` is set. The seeded manager PIN stays the demo's, since it's only
  usable after signing in.

## What it can't do

`resolveCredential` returns nothing on a practice copy, for what's in its database and its
env alike. So Stripe, Square, Twilio, SMTP, Gmail, the door counter, GitHub and the Mailchimp
libraries all behave as unconfigured, which each already handles. An env file copied from the
live deployment stays harmless.

Paths that don't use `resolveCredential` each have their own stop:

| What | How it's stopped |
|---|---|
| Five Mailchimp routes that read their key straight from the env | `mailchimpBaseUrl` returns an address that never resolves |
| Ops alerts to a webhook or email | `reportOpsAlert` stops after logging |
| Google Drive project folders, using the person's own Google sign-in | The route answers 409 |
| Settings › Integrations | The page says why, and the route refuses to store a key |

`__tests__/practiceOutbound.test.ts` lists everything on the server that can reach outside
Holt and what stops each. A new integration fails it until someone decides.

**Label printers still work.** They're on the store's own network and only print paper, and
printing tags is part of what staff practise. A printed price tag doesn't say it's practice.

**At the register**, a card tender is recorded by hand, as it is everywhere until card readers
(GAP-03). Sending a payment link says it's a practice copy and to record the payment by hand. The
customer portal's Pay button fails with its usual error, since nobody is using it here.

**Emails and texts wait in the queue.** They're still queued, so the screens behave as they
would, but `processEmailQueue` leaves them `PENDING`. Nobody receives anything.

## Start over

Admin › Setup › Database Backup, for whoever holds `admin.data`. The card appears only on a
practice copy.

- **Save as the starting point** copies the database to `<name>_start`. Saving again replaces
  it. It holds the store's real products, like the copy itself.
- **Start over** builds a fresh copy of the starting point, drops the current database, and
  renames the fresh one into place. If the copy fails, nothing has changed.
- **Then it catches up**: `prisma migrate deploy`, the built-in roles and the settings cache,
  since a starting point may be older than the running version.

Everyone is disconnected for a moment by both. The route and `lib/practiceCopyDatabase.ts`
both refuse a database not named as practice.

**Needs a database user that may create databases.** That's the default in
`docker-compose.yml`. Without it, both buttons say so.

**Uploaded files aren't restored.** Pictures added since the save stay on disk, unused.

### Why the tests don't cover this

Rule 59 keeps other databases out of the test suite, and this creates and drops them. So
`prisma/testing/practiceCopyDrill.ts` (`npm run practice:drill`) runs it for real on throwaway
databases, in CI after the seed. Point `DATABASE_URL` at a migrated database not named as
practice. It's copied, not changed.

## Not done

- **Practice sign-ins aren't the store's real staff.** Everyone uses the seed's accounts.
- **Seeded demo products stay beside the imported ones.** Owner's design, 2026-11-05.
- **A printed tag doesn't say practice.** See above.
