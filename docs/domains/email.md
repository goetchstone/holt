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
  `ticketReplyEmail` / `invoiceIssuedEmail` / `passwordResetEmail` /
  `purchaseOrderEmail` / `customerMessageEmail` → `{ subject, html }`. Inline styles; **all interpolated
  values HTML-escaped** (no injection from customer/author text). Tested.
- `config.ts` — `getSmtpConfig` / `isEmailConfigured` (above).
- `sender.ts` — **server-only** nodemailer transport (cached per config) +
  `sendEmail({to,subject,html,attachments?})`; no-ops when unconfigured. Import
  only from API routes / the queue. Tested over a real SMTP conversation with a
  sink on localhost (`__tests__/helpers/smtpSink.ts`), attachments included.
- `queue.ts` — `enqueueEmail` (PENDING row, with any attachments; pass a
  transaction to queue it with the caller's own write), `processEmailQueue`
  (send due rows, advance state; stops the run if SMTP is unconfigured),
  `enqueueAndSend` (fire-and-forget enqueue + drain after a write, never blocks
  the response), and `deliverQueuedEmail(id)` (try one row now and return its
  status, for a screen that tells the sender whether it went). Both senders go
  through one `deliverRow`, so a retry sends exactly what the first try did.

## Schema

`EmailQueue` + `EmailStatus` (PENDING/SENT/FAILED), org-scoped — `toAddress`,
`subject`, `html`, `templateKey`, `status`, `attempts`, `lastError`,
`scheduledAt`, `sentAt`. Migration `20260604001731_add_email_queue`.

`EmailQueueAttachment` (since 2026-10-30, migration
`20261030140000_stock_purchase_orders`): `filename`, `contentType`, `content`
(bytes), cascade-deleted with its row. The file is kept on the queue so a retry
after an SMTP failure sends the same bytes.

## Touchpoints (wired)

- **Automatic customer messages** (GAP-13): see "Customer messages" below.

- **Booking create** (`pages/api/bookings/index.ts`) → `booking-confirmation`.
- **Public ticket submit** (`pages/api/tickets/index.ts`) → `ticket-received`
  (with the `/support/<token>` status link).
- **Staff public reply** (`pages/api/tickets/[id]/messages.ts`, only when
  `isInternal=false` + submitter has an email) → `ticket-reply`.

All use `enqueueAndSend` (best-effort; the durable row survives an SMTP outage).

- **Purchase order to its vendor** (`pages/api/purchasing/orders/[id]/email.ts`,
  GAP-01) → `purchase-order`, the PO's PDF attached. It is the one touchpoint
  where the sender waits: `enqueueEmail` then `deliverQueuedEmail`, because the
  buyer needs to know the vendor got it, and a sent draft becomes Submitted.
  It refuses (409) when SMTP isn't configured rather than queueing a PO nobody
  sees waiting; a send that fails answers 502 and stays queued for the drain.
  See `docs/domains/purchasing.md`.
Status links use `NEXTAUTH_URL` as the base.

## Customer messages (GAP-13)

Messages Holt sends a customer by itself. Owner, 2026-11-03: each one on or off
with the store's own wording and timing, a fresh order link in each, a customer
opt-out, and the review invitation some days after handover; "All
configurations". DECISIONS 39.

- **Email or text.** Each message goes by email (where each starts), text, both, or
  whichever the customer prefers (`CustomerMessageSetting.channel`, GAP-12). A text
  has its own wording and link choice. Who may get one, the queue and opting out are
  in `sms.md`.
- **The kinds** are code (`lib/messages/catalog.ts`, shared with the screen).
  Each kind fixes which event sends it and which `{placeholders}` it can fill:
  - `ARRIVED`: goods ordered for the customer are received.
  - `DELIVERY_SCHEDULED`: the delivery is put on a run.
  - `DELIVERY_REMINDER`: some days before the delivery.
  - `REVIEW_INVITE`: some days after the handover.
- **The store's setting** is one `CustomerMessageSetting` row per kind
  (`lib/messages/settings.ts`; Settings › Customer messages,
  `/app/admin/setup/customer-messages`; `GET /api/customer-messages`,
  `PUT /api/customer-messages/[kind]`; admin.settings). It holds:
  - on or off;
  - the subject and wording;
  - whether it carries the "View your order" button;
  - for a timed kind, its days and the hour of the store's day;
  - for the review invitation, the review page (https, required to switch it
    on).

  A missing row is written on first read with the suggested wording, switched
  off. Switching a kind on stamps `activeSince`, and only events after it send.
  The config only selects (rule 62): the wording is text with placeholders,
  never an expression.
- **The scan** (`lib/messages/due.ts` `queueDueMessages`) runs at the start of
  every `POST /api/automations/email-queue`, so it runs every 5 minutes with the
  cron, and its emails drain in the same run. The rules per kind are in the
  file's header. In short:
  - **Arrivals** come from receipts against a PO line tied to an order line.
    Only goods that came onto the books in a saleable condition count, not
    quarantined ones (`receiptConditions.ts`) and not receipts imported with an
    `externalGipNo`. One message per order lists what came in, and each receipt
    is announced once (`CustomerMessage.receivingRecordIds`).
  - **Deliveries** are announced once per appointment and day, so a delivery
    moved to another day is announced again. A run's day is its stored UTC date
    (`timing.ts runDay`).
  - **A reminder** goes on its day, from its hour, and never late.
  - **A review invitation** is not sent once a return is open against the
    order, nor after the handover is undone.
  - **Nothing goes more than `LATE_LIMIT_DAYS` (7) late.**
- **Every event is recorded once** as a `CustomerMessage` (`dedupeKey` unique),
  sent or not. A customer with `Customer.autoMessagesOptOut` (the customer form's
  "No automatic messages"), or who can't be reached by the channels the message
  takes, gets a row with the reason and is not tried again for that event. With
  both channels, one that can't go doesn't stop the other: `skipReason` is the
  email's, `smsSkipReason` the text's, and `status` is `SKIPPED` only if nothing
  went. The row and its queue rows are written in one transaction
  (`enqueueEmail(input, tx)`), so two runs at once send one message. A failure (no `NEXTAUTH_SECRET` to sign the link, say)
  writes nothing, is logged, and is tried again on the next run.
- **Rendering** (`lib/messages/render.ts`, `templates.ts`
  `customerMessageEmail`) fills placeholders in one pass and escapes
  everything. A blank line starts a paragraph. The order button is a fresh
  portal link (`lib/portalLink.ts`, the same as the order page's copy-link,
  `AppSettings.portalTokenTtlHours`). `templateKey` is
  `customer-message-<kind>`.
- **The order page** shows each message and where its email stands
  (`GET /api/sales/orders/[id]/messages`, sales.read, `CustomerMessagesPanel`).
  It shows nothing when there are none. The mail server's error text stays on
  Admin › Email.

Not built (ROADMAP GAP-13): the "minutes out" notice (telematics), telling the
customer a quote hold is ending, and sending a message again by hand.

## Operate

- **Drain endpoint** `POST /api/automations/email-queue` — admin session OR
  `Authorization: Bearer $AUTO_IMPORT_API_KEY` (cron). It first queues the
  customer messages that are due, then drains the emails and the texts. Returns
  `{ summary: { processed, sent, failed, skipped }, texts, messages }`, where
  `texts` is the same count for the text queue, and `messages` is the scan's count
  per kind (null if the scan failed; the drain runs anyway).
- **Admin viewer** `/app/admin/email` — SMTP-configured banner, per-status
  counts, recent rows + last error, "Process now", and the same for texts. Card on
  the Admin hub.
- **The cron** (`scripts/auto-email-queue.sh`) runs every 5 minutes, installed
  by `scripts/install-cron.sh`. `scripts/go-live-check.sh` checks it is there.

## Verification checklist

- [ ] `npm run validate` clean; `emailState` + `emailTemplates` tests pass.
- [ ] With no SMTP: booking/ticket create succeeds, row sits PENDING, "Process
      now" reports skipped — nothing throws.
- [ ] With SMTP set: booking confirmation + ticket emails arrive; row → SENT.
- [ ] Internal ticket notes do NOT email the customer.
