# Contributing to Holt

## Getting Started

### Prerequisites

- Node.js 24+ (LTS)
- Docker and Docker Compose
- Git

### Local Development

```bash
# Clone your fork / repo
git clone <your-repo-url> holt
cd holt

# Start database
docker compose up db

# Install dependencies and set up Prisma
cd app
cp ../env.example .env.local
npm install
npx prisma generate
npx prisma db push

# Start dev server
npm run dev
```

The app runs at `http://localhost:3000`.

### Environment Variables

Copy `env.example` to `.env` at the repo root (for Docker Compose) and create `app/.env.local` for API keys. Required variables:

- `DATABASE_URL` -- PostgreSQL connection string
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` -- Google OAuth
- `NEXTAUTH_SECRET` -- Session encryption key
- `NEXTAUTH_URL` -- Base URL (e.g., `http://localhost:3000`)
- `APP_ENCRYPTION_KEY` -- key used to encrypt stored integration credentials

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

- Use the brand color tokens (`sh-*` Tailwind classes) — never hardcode hex colors. The tokens resolve to themeable CSS variables driven by each organization's saved theme, so settings re-skin the UI without code changes.
- Content max-width: `max-w-screen-lg` (enforced by `MainLayout`)
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

Use the in-app feedback button (bottom-right corner of every page) to submit issues directly. When a GitHub App integration is configured, this creates a GitHub Issue automatically with the current page URL and browser info.

Alternatively, open an issue in your repository's tracker and pick a template:

- **Bug Report** -- something is broken
- **Feature Request** -- new feature or improvement
- **Data Issue** -- wrong prices, missing records, import problems

Include screenshots when possible. Copy the page URL from the browser.

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

Database migrations are applied against the running DB container:

```bash
docker exec -i <db-container> psql -U <db-user> -d <db-name> \
  < app/prisma/migrations/<migration_name>/migration.sql
```

See [OPERATIONS.md](./OPERATIONS.md) for the full deploy, backup, and migration
procedures, including the reference Synology NAS setup.

### Build Requirements

- DB host port is 5433 (not 5432) to avoid conflicts with a host Postgres
- Nginx reverse proxy on port 8080 with 50MB upload limit and 300s timeout
- Some older Docker hosts need `DOCKER_BUILDKIT=0`
