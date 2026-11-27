# Contributing to Holt

Thank you for looking. Holt is built in the open, and reports, questions and
changes from people who run or work in stores are what make it better.

## Ways to take part

- **Report a bug, a bad import or a wrong number.** Open an issue and pick the
  form that fits. [SUPPORT.md](./SUPPORT.md) lists them.
- **Ask for a feature.** Describe the work you are trying to get done; that
  matters more than the screen you would add.
- **Ask a question.** Use the Question form after checking the README and the
  in-app help.
- **Report a security problem privately**, never as an issue:
  [SECURITY.md](./SECURITY.md).
- **Change the code or the docs.** See "Sending a change" below.

Everyone taking part is expected to follow the
[Code of Conduct](./CODE_OF_CONDUCT.md).

The issue tracker is public. Leave out real customer details, card or bank
details, passwords and keys, and any vendor file you are not free to publish.

## Sending a change

1. **Open an issue first for anything beyond a small fix.** Holt handles money,
   stock and tax, and many of its rules exist because of a specific past
   mistake. Agreeing the approach before you write the code saves both sides a
   rejected pull request.
2. **Fork, and branch from `main`.** Nothing is pushed to `main` directly; every
   change arrives as a pull request.
3. **Keep it to one change.** A fix and an unrelated tidy-up are two pull
   requests.
4. **Add a test that fails without your change.** Behaviour behind the database
   is tested against a real database, not a mock (see `app/__tests__/integration`).
5. **Run the checks** in "Before Every Commit" below.
6. **Update the docs your change makes untrue**, including the runbook for the
   area under `docs/domains/`.
7. **Open the pull request** and fill in the template. Say what you verified
   and what you could not.

CI must pass before a merge: lint, typecheck, format, unit and integration
tests with a coverage floor, a production build with a browser sweep of every
page, Semgrep, a dependency vulnerability scan and CodeQL. A maintainer reviews
every pull request; review is done as time allows.

[CLAUDE.md](./CLAUDE.md) holds the project's working rules and the incident
behind each one. It is written for the AI agents that do much of the work here,
and it is just as useful to a person: read the principles before changing
anything that sums money, filters on a nullable column or touches a shared
guard.

### Licence of contributions

Holt is licensed under the [GNU AGPL v3.0 or later](./LICENSE). By submitting a
contribution you agree that it is licensed under the same terms, and you
confirm that you wrote it or otherwise have the right to submit it under that
licence. There is no contributor licence agreement to sign.

## Getting Started

### Prerequisites

- Node.js 24+ (LTS)
- Docker and Docker Compose
- Git

### Local Development

Follow the [Quick Start in the README](./README.md#quick-start): it takes a
fresh clone to a signed-in system with demo data (`npm run setup` migrates and
seeds), and lists the demo sign-in.

The app runs at `http://localhost:3000`.

### Environment Variables

`env.example` (copied to `.env` at the repo root) holds the database
credentials Docker Compose uses. `app/.env.local.example` (copied to
`app/.env.local`) holds the app's own settings; the two you must fill in are
`APP_ENCRYPTION_KEY` (encrypts stored integration credentials) and
`NEXTAUTH_SECRET` (signs sessions).

All other configuration (branding, integration keys, import mappings) is set at
runtime via **Admin → Settings**, not through environment variables.

## Code Standards

### Before Every Commit

```bash
cd app
npm run validate    # lint + typecheck + format check
npm test            # all tests must pass
```

A pre-push hook enforces this automatically. Do not skip it.

### File Path Comments

Every source file starts with its path as a comment:

```typescript
// /app/src/pages/api/example.ts
```

This is relative to the repository root, prefixed with `/app/`.

### TypeScript

- Write new code as if `strict: true` were enabled
- Use proper types; avoid `any`
- Define interfaces for API request/response shapes

### Formatting

Prettier handles formatting. Run `npm run format` to auto-fix. Configuration:

- Semicolons, double quotes, 2-space indent, trailing commas
- Print width: 100
- Arrow parens: always

### Styling

- Use the brand color tokens (`brand-*` Tailwind classes) — never hardcode hex colors. The tokens resolve to themeable CSS variables driven by each organization's saved theme, so settings re-skin the UI without code changes.
- Content max-width: `max-w-screen-xl` (set by `AppShell`, `src/components/navigation/AppShell.tsx`, for every back-office page)
- Primary target: iPad Pro 12.9" -- minimum 44x44px touch targets

### Comments

- Brief and purposeful -- explain *why*, not *what*
- No tutorial-style or overly verbose comments
- No emojis in code, comments, or commit messages

## Architecture

### Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js 16 — App Router for feature pages; Pages Router retained for `src/pages/api/**` REST routes + `auth/login` |
| Language | TypeScript 5.9 |
| Data layer | tRPC 11 + @tanstack/react-query 5 + superjson (App Router); REST handlers in `src/pages/api/` |
| Database | PostgreSQL 17 |
| ORM | Prisma 7 (pg driver adapter, no Rust engine) |
| Auth | NextAuth 4 (pluggable: Google / Okta / Azure / local) |
| Styling | Tailwind CSS 4 + shadcn/ui |
| Testing | Jest + ts-jest |

### Key Directories

```
app/src/
  pages/          # Next.js pages + API routes
    api/
      consignment/  # Consignment receipts, items, payments, stats
      service/      # Service dispatch, installers, delivery zones
      sales/        # HD proposal import
    sales/          # Sales pages, HD proposal import page
    inventory/
      consignment/  # Consignment tracking UI
    service/        # Dispatch queue, house calls
  components/     # React components
  lib/            # Shared business logic and utilities
    pricing/
      hdProposalParser.ts   # Hunter Douglas proposal PDF parser (server-only)
    consignment.ts      # Consignment pricing and status mapping
    githubApp.ts        # GitHub App auth for feedback
    storeLocationResolver.ts  # Bridge string store names to FK
    requestLog.ts       # Request logging middleware
    rateLimit.ts        # Rate limiting for portal routes
  hooks/          # Custom React hooks
```

### Patterns

- **API routes**: Auth check, method check, try/catch with Prisma operations
- **Pages**: Client-side data fetching with `useEffect` + `fetch`/`axios`
- **Shared logic**: Lives in `src/lib/`, not in API routes or components
- **Prisma**: All models have `created`, `updated`, `createdBy`, `updatedBy` audit fields
- **Transactions**: Use `prisma.$transaction()` with `TX_TIMEOUT` constants for multi-table writes
- **Rate limiting**: Portal routes use `lib/rateLimit.ts` to prevent abuse
- **Feedback**: In-app `FeedbackButton` posts to GitHub Issues via GitHub App JWT auth

## Database

### Migrations

- **Never** modify a migration file after it has been applied
- Create new migrations for schema changes
- Test migrations against a copy of production data before applying
- Migration files go in `app/prisma/migrations/<name>/migration.sql`

### Schema Conventions

- Decimal fields for prices (not Float)
- Compound unique constraints for business keys (e.g., `@@unique([productNumber, vendorId])`)
- Cascading deletes on child relations where appropriate

## Submitting Issues

Open an issue at <https://github.com/goetchstone/holt/issues> and pick a form:

- **Bug report**: something is broken
- **Import or data problem**: a price book or other import that fails, or
  numbers that do not add up
- **Feature request**: something Holt should do, or do better
- **Question**: installing, configuring or using Holt

Include the commit you run, a screenshot when you can, and the page's path.

A store's own staff can also use the in-app feedback button (bottom-left corner
of every page). When that deployment has the GitHub App integration configured
in Admin → Settings → Integrations, it opens an issue in the repository that
deployment is pointed at, with the page URL and browser details.

## Commit Messages

- One logical change per commit
- Subject line describes the *why*, not the *what*
- No emojis
- Examples from this repo:
  - `Add order lifecycle management with line item cancel, replace, and audit trail`
  - `Add role-based nav permissions, UI polish, and touch target improvements`
  - `Fix receipt canvas showing during print and image scaling`

## Deployment

A self-hosted deployment runs via Docker Compose on any Docker host:

```bash
git pull origin main && ./scripts/deploy.sh
```

Pending database migrations are applied when the app container starts
(`prisma migrate deploy` in `app/docker-entrypoint.sh`).

See [OPERATIONS.md](./OPERATIONS.md) for the full deploy, backup, and migration
procedures, including notes for NAS-hosted setups.

### Build Requirements

- DB host port is 5433 (not 5432) to avoid conflicts with a host Postgres
- Nginx reverse proxy on 80/443 with a 300MB upload limit and 300s timeouts; the host's own jobs use
  `nginx-host` on 127.0.0.1:8080 (docs/HOSTING.md)
- Some older Docker hosts need `DOCKER_BUILDKIT=0`
