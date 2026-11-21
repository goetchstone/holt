# Browser page sweep

`app/e2e/` opens every App Router page in a real browser (Chromium, through
Playwright) and fails on what a person opening it would see go wrong. It runs
twice, once per seeded account (a Playwright project each):

- **the Owner** (`owner@example.com`), who holds every permission: every page
  must render at its own address, so any redirect not listed in
  `e2e/redirects.ts` fails. Without this, a page that refused the account and
  sent it to `/app` would pass without ever rendering;
- **the Administrator** (`admin@example.com`): a page that refuses them is
  skipped as not admitted, and a page that admits them must work. This is how a
  page gate wider than its data API's gate shows up.

Each run fails on:

- an HTTP status of 400 or more, a bounce to `/auth/login`, or an unlisted
  redirect;
- an uncaught client error or a `console.error`;
- a call to the app's own API (fetch or XHR) answering 400 or more;
- the error-boundary or not-found screen;
- a page whose Content-Security-Policy is missing, sent twice, or lets a script
  run without this request's nonce (no `'nonce-…'` or `'strict-dynamic'` in
  `script-src`, or an `unsafe-inline` or `unsafe-eval` there; `src/proxy.ts`,
  `docs/DECISIONS.md` entry 62). A script the policy blocks is a
  `console.error`, so a page whose scripts lost their nonce fails too.

Besides the two accounts' runs, it opens the Pages Router sign-in screens
(`/auth/login`, `/auth/forgot-password`, `/auth/reset-password`, read from
`src/pages`) signed out, once, under the same checks. Their scripts carry the
nonce only through `pages/_document.tsx`, and a mistake there stops anyone
signing in. And it checks that `/api/health` answers with the static API policy
from `next.config.js` (no nonce, no `unsafe` keyword for scripts), which also
shows the proxy did not run on `/api`.

Unit and integration tests never render a page, and `scripts/smoke.sh` fetches
one. Six PRs, #118 to #124 bar #121, shipped screens that nothing had opened.
The first runs, on 2026-11-20, found the Leads board 500ing on every load where
Mailchimp is not set up; four commission and pay screens an Administrator can
open whose data APIs refuse them; and two data APIs (the Leads board's
needs-attention strip, consignment receiving gaps) that refuse the Owner because
they check the staff enum for MANAGER or ADMIN by name.

## Running it

CI runs it in "Setup, build, boot, smoke", against a production build and a
database `npm run setup` has just seeded. By hand, against a running app:

```bash
cd app
DATABASE_URL=<that app's database> BASE_URL=http://localhost:3010 npm run test:pages
```

`DATABASE_URL` is read only, to find rows for dynamic routes. Sign-in uses
`SMOKE_OWNER_EMAIL`, `SMOKE_EMAIL` and `SMOKE_PASSWORD` (default: the seeded
Owner and Administrator, and the demo password), and needs
`AUTH_LOCAL_ENABLED=true` on the app. `SMOKE_ALL_MODULES=1` switches every
optional module on first, through the admin settings API: it changes the
deployment's settings, so use it only on a throwaway database, as CI does.

Point it at a production build (`npm run build && npm start`, or a local
instance), not `npm run dev`: development mode logs React warnings as console
errors, compiles each page on first visit, and adds `unsafe-eval` to the
policy, which the policy check fails.

`/portal/client/[token]` needs the running app's `NEXTAUTH_SECRET` exported in
the shell that runs Playwright. Its token is a signed JWT, not a row
(`lib/clientPortalToken.ts`), so the suite mints one with that secret. Unset, the
route skips; set to a different secret, it fails on the page's 404, because the
app really verifies the token. CI's smoke job gives the app and the suite the
same one.

## What decides what is opened

| File | Role |
|---|---|
| `e2e/pageRoutes.ts` | Every page route, read from the `page.tsx` tree, and the module a page requires; the Pages Router screens, read from `src/pages` |
| `e2e/dynamicRoutes.ts` | For each `[param]` route, how to find a seeded row to open it with, or why it is skipped |
| `e2e/knownFailures.ts` | Pages found broken and not yet fixed, per account (a ratchet) |
| `e2e/redirects.ts` | Pages that redirect on purpose, and where to |
| `e2e/signIn.ts` | Signs both accounts in, records which modules are on |

- A static route is opened as it is.
- A dynamic route opens the URL its `find` returns. When it returns null, CI fails
  (the seed is ours, and a page it cannot reach is a page nobody opened); a run
  against another database skips it and says why.
- A page whose `requireModule` key is off is skipped and says so.
- A page in `knownFailures.ts` is marked expected to fail: the run stays green
  while it fails, and goes red when it passes, so its fix must remove the entry.

`__tests__/e2eDynamicRoutes.test.ts` (unit, rule 65) fails when a dynamic route
has no entry, an entry names a route that is gone, a skip has no reason, or a
known failure or redirect names no real page or gives no reason. It also fails
when the Pages Router walk stops finding `/auth/login`, or picks up an API route
or `_app`/`_document`: an empty walk would leave the signed-out tests with
nothing to open, and green.

## Skipped today, and why

One dynamic route: the email campaign results detail,
`/app/reports/mailchimp/campaigns/[id]`. Its rows arrive from a Mailchimp sync,
and `prisma/seed/coverage.ts` classifies them as never seeded. Seeding invented
campaigns would reverse that, which is the owner's decision, not yet made.

Until 2026-11-21 six more were skipped: five for want of a seeded row, and the
client portal, whose token the suite did not mint. Where each route's row comes
from now (`docs/domains/seed-data.md`, "Rows the page sweep opens"):

| Route | Row |
|---|---|
| `/app/admin/buyer-drafts/buy/[id]/performance` | The one closed buy, rebuilt from received stock orders (`demo/buyerDrafts.ts`) |
| `/app/inventory/product-variance/[externalId]` | A snapshot product given the previous system's stock id (`demo/inventoryOps.ts`) |
| `/app/sales/invoices/[id]` | The authored draft invoice, the only invoice with lines (`demo/authoredInvoices.ts`). It took the first invoice by id before, an order invoice with no lines, so the page opened empty |
| `/app/sales/invoices/[id]/edit` | The same draft |
| `/portal/return/[token]` and `/portal/return/status/[token]` | The one return with a portal token, sent and not yet answered (`demo/returnLinks.ts`) |
| `/portal/client/[token]` | No row: a token the suite mints for a customer with tickets (see "Running it") |
