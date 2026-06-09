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

```bash
# Development (hot-reload)
docker compose --profile dev up

# Production
docker compose up -d --build

# Database only (for local app development)
docker compose up db -d
cd app && npm install && npx prisma generate && npm run dev
```

The app runs at `http://localhost:3000` (direct) or `http://localhost:8080`
(through Nginx). On first run, sign in with the bootstrap Google account; the
first user is granted admin until a privileged user exists.

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
