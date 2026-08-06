# Holt

_An [Akritos](https://akritos.com) product — technology small businesses own._

Holt is a business management platform for furniture and home-goods retailers.
It covers the whole operation in one system: product catalog and multi-dimensional
pricing, inventory and consignment, sales and purchasing, service dispatch, staff
scheduling, customer intelligence, and reporting.

It runs as **two surfaces from one codebase**: a public, themeable **storefront /
marketing site** powered by a built-in block-based **CMS** (managed in-app, no
rebuilds) at `/`, and the authenticated **back-office** at `/app`. Which modules a
deployment exposes is configured per-organization via feature flags
(Admin → Settings → Modules).

Holt is **open-core** and runs two ways from a single codebase:

- **Self-hosted** — one organization, one Docker Compose stack you operate.
- **Multi-tenant SaaS** — one organization per customer, centrally hosted.

Branding, integration credentials, and import mappings are configured in the
database through the in-app Settings screens. A deployment is white-labeled and
wired to its own systems without editing code.

## Quick Start

From a fresh clone to a logged-in system with ~18 months of demo data:

```bash
cp env.example .env                      # database credentials
cp app/.env.local.example app/.env.local # then fill APP_ENCRYPTION_KEY + NEXTAUTH_SECRET

docker compose up db -d                  # Postgres only
cd app && npm install
npm run setup                            # migrate + seed demo data + seed CMS
npm run dev
```

Open <http://localhost:3000/auth/login> and sign in:

| | |
|---|---|
| Email | `admin@example.com` |
| Password | `Showroom2026!` |

Every seeded staff account shares that password; `owner@`, `manager.*@`,
`designer1@`, `register1@` and `warehouse1@` exist too, each with a different
role, which is the quickest way to see how permissions behave.

Two values in `app/.env.local` are **required** and easy to miss:

- `APP_ENCRYPTION_KEY` — the app refuses to start without it (≥16 chars;
  `openssl rand -base64 32`).
- `AUTH_LOCAL_ENABLED=true` — without it the password provider is not
  registered and the seeded accounts cannot sign in. Google OAuth is optional
  and not needed to evaluate the system.

Verify the whole path end to end at any time:

```bash
cd app && bash scripts/smoke.sh    # boots?, seeded?, can log in?, data loads?
```

That script is also what CI runs, so "it starts and a person can use it" is a
gate rather than an assumption.

### Docker

```bash
docker compose --profile dev up      # hot-reload
docker compose up -d --build         # production build
```

The container applies migrations on start. A production build served over
plain http on localhost additionally needs `ALLOW_INSECURE_NEXTAUTH_URL=true`
— the https requirement is correct for a real deployment and only relaxes for
loopback addresses.

## Configuration

Three secrets live in the environment (`.env`) because they bootstrap the app
before the database is reachable:

- `DATABASE_URL` — Postgres connection string
- `NEXTAUTH_SECRET` — session signing key
- `APP_ENCRYPTION_KEY` — key that encrypts stored integration credentials

Everything else is configured at **Admin → Settings**:

- **Branding** — name, logo, favicon, colors (theme), tagline, support email
- **Integrations** — Stripe, Mailchimp, Google, and other provider keys, stored
  encrypted at rest and never returned to the browser in plaintext
- **Imports** — CSV column mappings; vendor/POS formats ship as reusable presets
  (`config/presets/`, YAML or JSON, editable in the admin UI or applied from git —
  see [config-presets](docs/domains/config-presets.md))

See `env.example` for the full environment template.

## Editions

- **Core** — catalog, pricing engine, sales, purchasing, customers, reporting,
  the CMS storefront (pages + navigation; blog is an optional module), and public
  booking with standard-calendar (.ics) invites + a staff iCal feed.
- **Premium (tiered)** — warehousing, dispatch and delivery planning,
  consignment, and the marketing/customer-intelligence suite. Premium modules
  are gated by the organization's plan.

## Development

```bash
cd app
npm run dev           # Start dev server
npm run validate      # Lint + typecheck + format check
npm test              # Run unit tests
npm run test:coverage # Unit + integration coverage (gate input)
```

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — module map, data model, integrations
- [CONTRIBUTING.md](./CONTRIBUTING.md) — branch/PR workflow and quality gates
- [OPERATIONS.md](./OPERATIONS.md) — deployment, monitoring, troubleshooting
- [docs/DEPLOYMENTS.md](./docs/DEPLOYMENTS.md) — white-label model: product = code,
  a deployment = data (branding, theme, CMS content, env); per-tenant setup
- [docs/](./docs/) — deployment topology, CI, migrations, and domain runbooks

## Tech Stack

Next.js 16 (**App Router + tRPC**; all feature pages on App Router, REST API routes retained),
TypeScript 5.9, PostgreSQL 17, Prisma 7 (pg driver adapter), Node.js 24 LTS, NextAuth 4 (pluggable
Google/Okta/Azure/local), Tailwind CSS 4 + shadcn/ui, Docker Compose.

## License

Holt is licensed under the **GNU Affero General Public License v3.0 or later**
(AGPL-3.0-or-later). You may run, study, modify, and self-host it freely; if you
offer a modified version to others over a network, you must make the corresponding
source available under the same license. See [LICENSE](./LICENSE) and the
attribution requirements in [NOTICE](./NOTICE).
