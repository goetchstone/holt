# Email (transactional)

Provider-agnostic transactional email — the #1 cutover blocker from the
RMS parity audit (the upstream RMS emailed booking confirmations + ticket
replies; Holt couldn't send). Built as a **durable queue + SMTP sender** that
**no-ops cleanly when SMTP is unconfigured**, so a fresh deployment runs fine
with email off and starts sending the moment credentials are added.

## Dependency

`nodemailer` **8.0.10** (GA). Chosen over staying on 7.x because the 7.x line is
unpatched for GHSA-vvjj-xcjg-gr5g / GHSA-c7w3-x93f-qmm8 (SMTP CRLF / envelope
injection, fixed in 8.0.5+). next-auth 4 declares `peerOptional nodemailer@^7`,
but that peer is **unused** (we use Google/local auth, never next-auth's Email
provider), so `overrides.nodemailer = "^8.0.10"` in package.json pins the patched
GA version with no real conflict. `npm audit --omit=dev` = 0.

## Config (DB-first, env fallback)

SMTP creds resolve via `resolveCredential("smtp", <field>, <ENV>, orgId)` —
the encrypted `IntegrationCredential` store first, then env:

| Field | Env fallback |
|---|---|
| host | `SMTP_HOST` |
| port | `SMTP_PORT` (default 587; 465 ⇒ implicit TLS) |
| user | `SMTP_USER` |
| pass | `SMTP_PASS` |
| fromAddress | `EMAIL_FROM` (falls back to user) |
| fromName | `EMAIL_FROM_NAME` |

`getSmtpConfig()` returns `null` when host or from-address is missing →
`isEmailConfigured()` is false → the sender returns `{ skipped: true }`.
Configurable in **Settings → Integrations** (provider `smtp`, added to
`lib/integrationCatalog.ts`) or via env on the host.

## Pieces (`lib/email/`)

- `state.ts` — pure `nextEmailState(priorAttempts, ok, now, error)` retry machine;
  PENDING until `MAX_EMAIL_ATTEMPTS` (4), then FAILED. Tested.
- `templates.ts` — pure `bookingConfirmationEmail` / `ticketReceivedEmail` /
  `ticketReplyEmail` → `{ subject, html }`. Inline styles; **all interpolated
  values HTML-escaped** (no injection from customer/author text). Tested.
- `config.ts` — `getSmtpConfig` / `isEmailConfigured` (above).
- `sender.ts` — **server-only** nodemailer transport (cached per config) +
  `sendEmail({to,subject,html})`; no-ops when unconfigured. Import only from API
  routes / the queue.
- `queue.ts` — `enqueueEmail` (PENDING row), `processEmailQueue` (send due rows,
  advance state; stops the run if SMTP is unconfigured), and `enqueueAndSend`
  (fire-and-forget enqueue + drain after a write, never blocks the response).

## Schema

`EmailQueue` + `EmailStatus` (PENDING/SENT/FAILED), org-scoped — `toAddress`,
`subject`, `html`, `templateKey`, `status`, `attempts`, `lastError`,
`scheduledAt`, `sentAt`. Migration `20260604001731_add_email_queue`.

## Touchpoints (wired)

- **Booking create** (`pages/api/bookings/index.ts`) → `booking-confirmation`.
- **Public ticket submit** (`pages/api/tickets/index.ts`) → `ticket-received`
  (with the `/support/<token>` status link).
- **Staff public reply** (`pages/api/tickets/[id]/messages.ts`, only when
  `isInternal=false` + submitter has an email) → `ticket-reply`.

All use `enqueueAndSend` (best-effort; the durable row survives an SMTP outage).
Status links use `NEXTAUTH_URL` as the base.

## Operate

- **Drain endpoint** `POST /api/automations/email-queue` — admin session OR
  `Authorization: Bearer $AUTO_IMPORT_API_KEY` (cron). Returns
  `{ sent, failed, skipped }`.
- **Admin viewer** `/app/admin/email` — SMTP-configured banner, per-status
  counts, recent rows + last error, "Process now". Card on the Admin hub.
- A daily cron hitting the drain endpoint retries any FAILED/PENDING (add when
  setting up the host).

## Verification checklist

- [ ] `npm run validate` clean; `emailState` + `emailTemplates` tests pass.
- [ ] With no SMTP: booking/ticket create succeeds, row sits PENDING, "Process
      now" reports skipped — nothing throws.
- [ ] With SMTP set: booking confirmation + ticket emails arrive; row → SENT.
- [ ] Internal ticket notes do NOT email the customer.
