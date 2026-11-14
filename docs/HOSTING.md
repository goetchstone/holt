# Hosting Holt

For the owner of a business running Holt, and for whoever installs it for them:
what Holt runs on, how big a server it needs, where it can live, and how to run
it as more than one process when one is not enough.

**Every size and price on this page is an estimate, not a measurement.** No load
test has been run against Holt yet. The numbers come from what the software does
(how many database connections a process opens, what runs inside a request) and
from ordinary experience with web applications of this shape. Treat them as a
starting point and watch your own server; this page will be corrected once a load
test exists.

## 1. The business owns its deployment

One deployment of Holt serves one business: its stores, its staff, its customers.
The business owns it outright:

- **Its accounts.** The server, the domain, the backups and the payment processor
  are in the business's own name and its own accounts, never the installer's.
- **Its server.** In a cloud account, on a rented virtual server, on a machine in
  a data centre, or on a machine in the back office. Holt runs the same way on
  all of them (section 3).
- **Its data.** The database and the uploaded files sit on that server, and the
  backups go where the business decides. Card numbers never do: they stay with
  the payment processor.

Holt is installed for the business; it is not a service the business rents. When
an installer leaves, the business keeps everything.

## 2. How big a server

By the number of staff who use Holt during the day, on one deployment. More stores
mostly means more staff; what loads the server is people working at the same time,
and the imports and reports they run.

| Staff | Stores (typical) | Server | App processes | Database | Status |
|---|---|---|---|---|---|
| up to ~25 | 1 | 2 vCPU, 4 GB memory, 50 GB SSD | 1 | Postgres on the same server | Supported |
| ~25-75 | 2-4 | 4 vCPU, 8-16 GB memory | 2-4 | Postgres on the same server | Supported |
| ~75-250 | 5-15 | 8 vCPU, 32 GB memory, or an app server plus a managed database | 4-8 (at 6-8, `PG_POOL_MAX` 5-6) | Managed Postgres with a standby | Supported on one server; a managed database is untested (below) |
| ~250-1,000 | 15-50 | Several app servers behind a load balancer | several per server | Managed Postgres, a connection pooler | **Planned, not supported yet** |
| Across regions | any | App servers in several cloud regions | | One primary database, a standby in a second region | **Planned, not supported yet** |

All of these are estimates (see the top of this page).

**Up to ~25 staff, one store.** One small server runs everything: nginx, one app
process and Postgres, as `docker compose up -d` starts them. Nothing to tune.

**~25-75 staff, 2-4 stores.** A bigger server, and 2-4 app processes
(`APP_REPLICAS`, section 4) so one person's slow report or import does not hold
up everyone else's screen. Schedule the daily POS import for quiet hours at
**Admin → Automations**, so it runs while few people are waiting on the
processes. Holt runs a scheduled job inside one app process, not on a separate
worker, so this is the way to keep heavy work off the busy part of the day. Big
price book loads and month-end reports are not scheduled jobs: run them by hand,
out of hours, until the planned job queue (below) can take them.

**~75-250 staff, 5-15 stores.** Move the database off the app server: a managed
Postgres (from the same cloud provider) with a standby that takes over if the
primary fails, and automated off-site backups. At 6-8 app processes, lower
`PG_POOL_MAX` to 5 or 6, and check the managed plan's connection limit: small
plans allow fewer than Postgres's usual 100 (section 4).

**A managed database.** Holt has not yet been tested against one. The app only
needs `DATABASE_URL` pointed at it, but the server's own scripts assume the
database container that comes with Holt:

- `scripts/backup-db.sh`, `scripts/restore-db.sh` and `scripts/deploy.sh`'s
  pre-deploy backup work on that container, not on whatever `DATABASE_URL`
  names. Pointed elsewhere, they would back up or restore an empty local
  database, so the first two refuse when `DATABASE_URL` is not the bundled one.
  Use the provider's own automated backups and point-in-time restore, and run
  deploys with `SKIP_BACKUP=1` once those are on.
- The bundled `db` container still starts (the app waits for it), empty. It does
  no harm, but it is not your database.

What Holt does **not** do yet at this size:

- It sends every query to one database. A read replica for reports would help
  here, but Holt has no way to send report queries to one yet.
- The uploaded files (product photos, attachments) live on the app server's disk.
  The app server can be replaced or resized, but there can be only one of it.

**~250-1,000 staff, 15-50 stores. Planned, not supported yet.** A business this
size needs more than one app server, and Holt is not ready for that. What is
missing:

- **Uploads on one server's disk.** A second app server would not see the files
  the first one stored. They need to move to shared storage first.
- **No connection pooler tested.** Several servers' processes would open more
  database connections than Postgres allows; a pooler in front of Postgres is the
  usual answer, and Holt has not been tested behind one.
- **No job queue.** Scheduled jobs run inside an app process, started by the
  server's cron (section 4). With several servers that needs a proper queue.
- **No slow-query monitoring** built in, which at this size you need in order to
  find the report that is slowing everyone down.

What already works across servers: sessions (signed cookies any process can
check), rate limits and cache invalidation (both kept in the database), and every
lock that protects money and stock (database locks, not memory).

**Across regions. Planned, not supported yet.** One deployment spread over
several cloud regions: one primary database with a standby in a second region
that can take over, read replicas near far-away stores, app servers in each
region behind a global load balancer, and uploaded files copied between regions.
Every write still goes to the one primary. This is not separate installs that
share data. It builds on the multi-server tier above, so it comes after it.

## 3. Where to host it

Any of these works. What matters is the checklist under each.

Rough monthly costs, for the first two sizes in section 2, as of late 2026. They
are estimates and they drift; check the provider's own prices.

| Where | Small (1 store) | Medium (2-4 stores) |
|---|---|---|
| Cloud (e.g. AWS, Google Cloud) | ~$40-80 | ~$120-300 |
| Rented virtual server (e.g. DigitalOcean or similar) | ~$25-50 | ~$50-150 |
| Private server in a data centre | ~$50-150 | ~$100-250 |
| On-site machine | hardware once, plus power and a business internet line | same |

**Cloud.**
- The account is the business's own, with its own billing and its own admin login.
- Backups go off the server: to object storage in the same account, kept for at
  least 30 days, and a restore tried once before go-live (`scripts/restore-drill.sh`).
- HTTPS with a real certificate (`scripts/init-letsencrypt.sh`, docs/PRODUCTION.md).
- Firewall: only ports 80 and 443 open to the internet, plus SSH from known
  addresses.

**Rented virtual server.**
- The same list as the cloud. Turn on the provider's own snapshots as well, but
  keep the database backups too: a snapshot taken mid-write is not a clean backup.

**Private server in a data centre.**
- The same list, plus: know who replaces a failed disk and how fast, and keep the
  backups somewhere other than that data centre.

**On-site, in the back office.**
- A UPS (battery backup) that keeps the server up through short power cuts and
  shuts it down cleanly in a long one.
- Backups that leave the building every night. A backup in the same room burns
  with the server.
- A business internet line, and a backup line (a second provider, or a mobile
  data router) when other stores depend on this server: if the line is down,
  every store is down.
- Reach it through a tunnel or a VPN, not by opening a port on the router. A
  router port forward puts the server straight on the internet. With a VPN,
  staff connect to the server's own address and nothing changes. With a tunnel,
  point it at nginx on the server's ports 80 and 443. The certificate
  (`scripts/init-letsencrypt.sh`) is only issued and renewed when the domain's
  port 80 reaches nginx, so the tunnel must carry it. Never point a tunnel at
  port 8080: that is the server's own way in for its jobs (section 4). Holt has
  not been tested behind a tunnel yet.
- The machine is somewhere locked, not under the front counter.

## 4. Running more than one app process

Holt can run as several identical app processes on one server, behind nginx,
which hands each request to the next process in turn. They share one database and
one uploads folder.

### Turning it on

In the root `.env`:

```
APP_REPLICAS=3
PG_POOL_MAX=10
```

then `./scripts/deploy.sh` (or `docker compose up -d`). The count is part of the
compose file (`scale: ${APP_REPLICAS:-1}`), so every later `up`, deploy or restore
keeps it.

- `APP_REPLICAS` -- how many app processes. 1 by default.
- `PG_POOL_MAX` -- how many database connections each process may open. 10 by
  default. The rule: **`APP_REPLICAS x PG_POOL_MAX` must stay under Postgres's
  `max_connections`, with room to spare.** Postgres allows 100 unless you change
  it, and backups, migrations and anyone using psql need connections too. Three
  processes at 10 is 30, which is comfortable; eight at 10 is 80, which is not.

A rough guide to the count: one process per CPU core, leaving one core for
Postgres when it runs on the same server. More processes than cores does not help.

### What the processes share, and what they don't

Shared, so it does not matter which process answers:

- **The database**: everything Holt knows.
- **Sessions**: a signed cookie that any process can check, as long as they all
  have the same `NEXTAUTH_SECRET` (they read the same `.env`).
- **Uploaded files**: one `uploads` volume mounted into every process.
- **Rate limits** (sign-in attempts, password resets, payments): counted in the
  database, so the limit is the same with one process or ten.
- **Migrations**: run once, by the compose `migrate` service, before any process
  starts.

Not shared:

- **Each process's small caches** (who may do what, the settings, sign-in
  providers, store names, the import's fallback rows). A change made through one
  process reaches the others **within about two seconds**: each process checks a
  change counter in the database at most every 2 seconds
  (`CACHE_GENERATION_CHECK_MS` in `app/src/lib/cacheGeneration.ts`). So a
  permission you take away stops working everywhere within that time, and a
  settings change or a store added, renamed or deleted shows up everywhere
  within it. After a database restore, every process drops everything it held.
- **Each process's database connections** (`PG_POOL_MAX` each).

### Checking it is spreading

```
docker compose ps app
```

lists one line per process, each `healthy` once it is up. Then, after a few
minutes of use:

```
docker compose logs nginx | grep -o 'upstream=[0-9.:]*' | sort | uniq -c
```

counts how many requests each process answered (nginx writes the process's
address on every request). Every process should appear, with similar counts.

### What happens on a deploy

`scripts/deploy.sh` builds the new version, migrates the database while the old
processes still answer, then replaces the processes and waits until every one of
them answers "ready" before it reports success. Replacing them is not seamless:
expect a few seconds in which some requests fail, so deploy outside business
hours.

### The host's own jobs

The app has no port of its own on the server. Browsers come in through nginx on
80 and 443. Jobs that run on the server itself -- the automations tick that cron
calls every 5 minutes, the deploy's health check, the restore script -- come in
through a second, small nginx (`nginx-host`) on `127.0.0.1:8080`, which only the
server itself can reach. Each request there goes to one process, like any other.
It has no certificate and needs none, so those jobs keep working when the public
site's certificate is missing or broken.
