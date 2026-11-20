# Browser page sweep

`app/e2e/` opens every App Router page in a real browser (Chromium, through
Playwright), signed in as the seeded admin, and fails on what a person opening
it would see go wrong:

- an HTTP status of 400 or more, or a bounce to `/auth/login`;
- an uncaught client error or a `console.error`;
- a call to the app's own API (fetch or XHR) answering 400 or more;
- the error-boundary or not-found screen.

Unit and integration tests never render a page, and `scripts/smoke.sh` fetches
one. Six PRs, #118 to #124 bar #121, shipped screens that nothing had opened.
The first run, on 2026-11-20, found the Leads board 500ing on every load where
Mailchimp is not set up, and four commission and pay screens an Administrator
can open whose data APIs refuse them.

## Running it

CI runs it in "Setup, build, boot, smoke", against a production build and a
database `npm run setup` has just seeded. By hand, against a running app:

```bash
cd app
DATABASE_URL=<that app's database> BASE_URL=http://localhost:3010 npm run test:pages
```

`DATABASE_URL` is read only, to find rows for dynamic routes. Sign-in uses
`SMOKE_EMAIL` / `SMOKE_PASSWORD` (default: the seeded admin), and needs
`AUTH_LOCAL_ENABLED=true` on the app. `SMOKE_ALL_MODULES=1` switches every
optional module on first, through the admin settings API: it changes the
deployment's settings, so use it only on a throwaway database, as CI does.

Point it at a production build (`npm run build && npm start`, or a local
instance), not `npm run dev`: development mode logs React warnings as console
errors and compiles each page on first visit.

## What decides what is opened

| File | Role |
|---|---|
| `e2e/pageRoutes.ts` | Every page route, read from the `page.tsx` tree, and the module a page requires |
| `e2e/dynamicRoutes.ts` | For each `[param]` route, how to find a seeded row to open it with, or why it is skipped |
| `e2e/knownFailures.ts` | Pages found broken and not yet fixed (a ratchet) |
| `e2e/signIn.ts` | Signs in once, records which modules are on |

- A static route is opened as it is.
- A dynamic route opens the URL its `find` returns. When it returns null, CI fails
  (the seed is ours, and a page it cannot reach is a page nobody opened); a run
  against another database skips it and says why.
- A page whose `requireModule` key is off is skipped and says so.
- A page in `knownFailures.ts` is marked expected to fail: the run stays green
  while it fails, and goes red when it passes, so its fix must remove the entry.

`__tests__/e2eDynamicRoutes.test.ts` (unit, rule 65) fails when a dynamic route
has no entry, an entry names a route that is gone, a skip has no reason, or a
known failure names no real page.

## Skipped today, and why

Seven dynamic routes have no seeded row to open (`dynamicRoutes.ts` says which
model is missing): a buyer-draft buy, a product with an `externalId`, a
Mailchimp campaign, a DRAFT invoice, a return with a portal token (two routes),
and the client portal, whose token is a signed JWT rather than a row. Each is a
seed gap tracked in the local roadmap; closing one turns its skip into a `find`.
