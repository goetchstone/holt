# Production go-live checklist

The single source of truth for taking a Holt deployment live (Akritos on a
VPS, Saybrook on the Synology, or any client). Grouped by what the CODE now
handles automatically vs what YOU do at deploy time. Derived from the
2026-06-10 production-readiness audit.

Legend: ☑ = handled in code · ☐ = deploy-time action you take.

## 1. Secrets & environment

- ☑ The app **refuses to boot** if `DATABASE_URL`, `NEXTAUTH_SECRET`, or
  `APP_ENCRYPTION_KEY` is missing/short, or if `NEXTAUTH_URL` isn't `https://`
  in production (`lib/validateEnv.ts` via `instrumentation.ts`). A
  misconfigured deploy fails loudly at startup, not as a later 500.
- ☐ Generate strong unique `NEXTAUTH_SECRET` and `APP_ENCRYPTION_KEY`
  (`openssl rand -base64 48`). Set `NEXTAUTH_URL=https://<domain>`.
- ☐ **`APP_ENCRYPTION_KEY` is sacred** — it decrypts every stored integration
  credential (Stripe, SMTP, ...). Store it in your secret manager / password
  vault. Losing it = re-entering every integration key by hand. It is NEVER
  in a backup (see `docs/SECRETS.md`); re-inject it on every deploy.
- ☐ Set `TRUST_PROXY=true` (the app sits behind nginx; this makes rate-limit
  IP attribution use the proxy hop, not a spoofable header).

## 2. TLS / HTTPS  ← the one true go-live blocker

- ☐ `nginx/nginx.conf` ships HTTP-only. Add a 443 server block with certs
  (Let's Encrypt / certbot), redirect 80→443, and pass
  `X-Forwarded-Proto $scheme`. Without this, sessions + Stripe + passwords
  travel in plaintext.
- ☑ HSTS, X-Frame-Options DENY, X-Content-Type-Options, Referrer-Policy, a
  baseline CSP, and `__Secure-` session cookies are all set in code — they
  activate the moment TLS is in front. (CSP still allows `unsafe-inline` for
  scripts/styles; tightening to nonces is tracked, not a blocker.)

## 3. Database, migrations, backups

- ☑ `scripts/deploy.sh` now migrates with the NEW image **before** swapping
  the app (no schema-mismatch window), then health-gates and exits non-zero
  on failure. Additive migrations are zero-error; **destructive** ones
  (drop/rename a column the running code still reads) need a two-phase
  deploy: ship the code that no longer uses the column, deploy, THEN ship the
  migration that drops it.
- ☑ `/api/health` reports DB + AppSettings readiness; the app container has a
  healthcheck + `stop_grace_period`.
- ☐ Schedule `scripts/backup-db.sh` (cron/Task Scheduler) with off-box
  retention. **Do a restore drill before go-live** — restore the latest
  backup into a scratch DB and boot against it (procedure in
  `docs/DISASTER-RECOVERY.md`). A backup you've never restored is a hope.
- ☐ Back up `data/uploads/` (ticket attachments, inventory photos, line
  drawings) — it is NOT in the SQL dump. Wire it into your backup job.

## 4. Scheduled jobs (cron) — register ALL of these on the host

Each is a manually-callable endpoint until a scheduler invokes it. Use a
Bearer `AUTO_IMPORT_API_KEY`. The cron wrapper (PR2) alerts on failure.

- ☐ **`auto-email-queue.sh`** — drains the email queue. **Without it, every
  invoice / booking confirmation / ticket reply / password-reset email
  silently never sends.** Every ~5 min.
- ☐ `auto-customer-ar-drift-check.sh` — nightly; flags books that don't tie out.
- ☐ `auto-daily-reconciliation.sh` — nightly (Saybrook).
- ☐ `auto-lead-housekeeping.sh`, `auto-mailchimp-sync.sh`,
  `auto-customer-level-recalc.sh`, `auto-axper-traffic.sh` — per their cadence.
- ☐ Saybrook only: `auto-import.sh` (06:10) for the daily Ordorite reports +
  the Gmail service-account JSON mounted at `config/service-account.json`.

## 5. Observability & alerting

- ☑ Cron scripts check the HTTP status + response body and fire an ops alert
  on failure/drift (`lib/opsAlert.ts`); the Stripe webhook wraps its ledger
  ops and alerts on a failed payment post.
- ☐ Set the alert channel: `OPS_ALERT_WEBHOOK` (Slack/Discord/generic) and/or
  `OPS_ALERT_EMAIL`. With neither set, alerts log only — fine for a pilot,
  not for production.
- ☐ Optional but recommended: set `SENTRY_DSN` for error tracking.
- ☐ Point an external uptime monitor at `/api/health`.

## 6. Payments (Stripe)

- ☑ Issuing an invoice **refuses** unless the AR + revenue GL accounts and
  their SystemGLMappings exist (it never posts to nowhere). `/api/health` and
  Admin → Setup → Accounting surface whether they're configured.
- ☑ The Stripe webhook is signature-verified and idempotent; payment
  application is bound to the invoice structurally (not via metadata).
- ☐ Enter **live** Stripe keys + the **webhook signing secret** in Settings →
  Integrations (encrypted at rest). Register the webhook endpoint
  `https://<domain>/api/stripe/webhook` in the Stripe dashboard.
- ☐ Configure the **AR Transactions** GL mappings (Accounts Receivable,
  Invoice Sales, Sales Tax) before issuing the first invoice.

## 7. Email (SMTP)

- ☑ The app degrades cleanly when SMTP is unconfigured (queues, no crash).
- ☐ Enter SMTP host/port/user/pass + from-address in Settings → Integrations,
  send a test, and confirm `auto-email-queue.sh` is scheduled (§4).

## 8. First-boot bootstrap (every new deployment)

- ☐ Apply migrations (`scripts/deploy.sh` does this).
- ☐ `npm run create-admin <email> <password>` for the first SUPER_ADMIN.
- ☐ Akritos: `node scripts/seed-akritos.mjs` (brand + 27 CMS URLs). Saybrook:
  restore the prod backup + run the Ordorite import.
- ☐ In Settings: set name/logo/theme, currency/locale/timezone, and toggle
  the feature modules this tenant uses (billing, clientPortal, legacyArchive,
  helpdesk, booking, cms, ...). All default OFF.
- ☐ `/api/health?ready=1` returns 200.

## Quick "is it safe to take money?" gate

TLS on · backups scheduled + one restore drilled · uploads backed up ·
`auto-email-queue.sh` running · ops alert channel set · live Stripe keys +
webhook secret + AR GL mappings configured · `create-admin` done. When all
nine are true, you can issue real invoices.
