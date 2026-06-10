# Client Portal

No-login hub for consultancy clients (feature flag `clientPortal`, default
off): one tokenized link shows a customer their appointments, invoices (with
online payment), and support-ticket statuses.

## Token model

`lib/clientPortalToken.ts` — stateless JWT signed with `NEXTAUTH_SECRET`,
payload `{ customerId, scope: "client-portal" }`, 30-day expiry. Same
pattern as the order-scoped `lib/portalToken.ts`; the `scope` claim keeps
the two capabilities isolated (an order token can never open the client hub
— pinned by `__tests__/clientPortalToken.test.ts`). No DB row: revocation is
by expiry; a fresh link supersedes nothing and invalidates nothing.

## Surfaces

- **Public hub** `/portal/client/[token]` — server-rendered
  (`app/src/app/portal/client/[token]/page.tsx`): verifies the feature flag
  + token, loads `getClientPortalData`, 404s on anything invalid
  (indistinguishable from a wrong URL). The only client-side interaction is
  the invoice Pay button.
- **Pay endpoint** `POST /api/client-portal/pay` — public, rate-limited
  (10/min), body `{ token, invoiceId }`: re-verifies the token, refuses
  unless the invoice belongs to the token's customer, then reuses
  `createInvoicePaymentLink` from the billing module (PENDING payment bound
  via `Payment.invoiceId`; the Stripe webhook completes + applies it like
  any invoice payment).
- **Staff link generation** — tRPC `clientPortal.generateLink`
  (MANAGER/ADMIN, feature-gated): returns
  `{NEXTAUTH_URL}/portal/client/<token>`. Surfaced as "Copy Portal Link" on
  the invoice detail action bar.

## Data assembly (`lib/clientPortal.ts`)

- **Appointments**: `Booking` rows matched by the customer's email
  (case-insensitive), `CANCELLED` excluded, newest 20.
- **Invoices**: authored invoices (`organizationId` = deployment org) for
  the customerId, `ISSUED`/`PAID` only — drafts and voids never show; open
  balance = total − applications.
- **Tickets**: linked by `customerId` OR submitter email; each links to its
  existing `/support/[publicToken]` status page.

Cross-customer leakage is the failure mode that matters — pinned by
`__tests__/integration/clientPortal.integration.test.ts` (another
customer's bookings/invoices/tickets never appear; pay endpoint refuses
foreign invoices by construction).

## Dependencies

Requires the `billing` module's lib for payments (the portal is read-only
without it in practice — Pay buttons error cleanly if Stripe/billing is
unconfigured). Email/SMTP not required.
