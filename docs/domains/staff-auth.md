# Staff & Auth

Role-based access control, permission-derived navigation, up-board staff rotation.

## Permissions: what is and is NOT enforced (2026-08-06)

**Read this first.** The permission layer is now the majority of the _guarded_
API surface: of the 337 Pages Router route files that carry one of the two
guards, **216 gate on a capability** and **121** still gate on the `StaffRole`
enum. Nav is derived from permissions. Page gates and hub card filtering still
name roles, so the enum has not gone away.

| Piece                                                              | State                                                                                         |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `PERMISSIONS` / `BUILT_IN_ROLES` (`lib/auth/permissionCatalog.ts`) | Complete — 48 permissions across 14 domains, 8 built-in roles                                 |
| `Role`, `RolePermission`, `StaffMember.roleId`                     | Exist, migrated, backfilled                                                                   |
| Built-in role seed                                                 | Runs on every deploy                                                                          |
| `requirePermission()` (Pages Router)                               | **216 route files use it**                                                                    |
| `permissionProcedure()` (tRPC)                                     | Exists; **0 procedures use it** — tRPC routers still use `roleProcedure(...)`                 |
| The other **121** Pages Router API routes                          | Still `requireAuthWithRole([...])` on the enum                                                |
| Nav                                                                | Derived from permissions (`lib/auth/navPermissions.ts`); the `NavPermission` table is dropped |
| Page-level `requirePage`, card filtering                           | Still the enum, apart from four pages (see Page-Level Auth)                                   |
| Custom-role admin GUI                                              | Ships at `/app/admin/setup/roles`                                                             |
| `StaffRole` enum                                                   | Still present, still authoritative for those 121 routes                                       |

The first route converted was `POST /api/sales/orders/[id]/refunds`, gated on
`payment.refund`. It was chosen because the PR #67 audit found it had no
authorization at all — any signed-in account could refund a card — and it moved
from the stopgap `requireAuthWithRole(["MANAGER", "ADMIN"])` to the capability
it was really asking for. The set of people who can call it is unchanged.

### The model

- **`Role`** — `key` (equals the `StaffRole` value for the eight built-ins),
  `name`, `description`, `rank`, `isSystem`, `grantsAllPermissions`,
  `grantsCustomized`.
- **`RolePermission`** — `(roleId, permission)`. `permission` is TEXT, not an
  enum: the catalog is the single source of truth and a config preset must be
  able to name a key without a schema migration. The database therefore cannot
  validate it — `findOrphanPermissionKeys()` is the check, and the seeder runs
  it every deploy.
- **`grantsAllPermissions`** — the `"*"` wildcard, as a boolean. SUPER_ADMIN
  has ZERO `RolePermission` rows on purpose. Rows would freeze the Owner's
  grants at seeding time and silently withhold every permission a later release
  adds. The check short-circuits on the flag.
- **`rank`** — used ONLY to stop impersonation escalating, same as
  `ROLE_RANK` in `roleDecision.ts`. Carried on `Role` so a deployment's own role
  participates instead of ranking 0. A row may _raise_ a rank, never lower one
  below the built-in value — otherwise setting SUPER_ADMIN's rank to 0 in the
  database would let an ADMIN impersonate up into it.
- **`isSystem`** — ships with the product; reseeded every deploy and must not
  be deletable (a deployment could lock itself out). Roles the deployment
  invents are `isSystem = false` and the seeder never touches them.
- **`StaffMember.roleId`** — nullable FK, coexisting with the `role` enum. See
  `docs/DECISIONS.md` #17 for why both, and why nullable.

### Where the built-in roles get seeded

`syncBuiltInRoles()` in `lib/auth/builtInRoles.ts` is the one implementation.
It runs from three places, all of which call it:

1. **`src/instrumentation.ts`** — the Next.js startup hook, so every server boot
   reconciles. This is the "runs wherever migrations run" guarantee:
   `docker-entrypoint.sh` applies migrations and then `exec`s `next start`.
   It lives here rather than in the entrypoint script because the production
   image ships only `.next/`, `node_modules/` and `prisma/` — there is no
   `src/` or `scripts/` in the container for a ts-node seeder to import.
   Failure is logged, not fatal.
2. **`npm run seed:roles`** (`scripts/seed-roles.mjs`) — for local dev, ops, and
   `scripts/setup.sh`, which calls it right after `prisma migrate deploy`.
3. **The migration itself** — `20260806160000_role_and_role_permission` inserts
   a point-in-time snapshot of the eight roles and their grants, so any path
   that only ever runs `prisma migrate deploy` still ends with a usable
   installation. The snapshot is not the source of truth and is never edited;
   the seeder reconciles it against the catalog afterwards.

**What a reseed does to a deployment that edited a built-in role:** nothing, to
its grants. `Role.grantsCustomized` is set the first time a deployment edits a
built-in role's grants — the Roles GUI's `PUT` sets it, and only when the grant
list actually changed (`pages/api/admin/roles/[id].ts`), as does a config preset
that names a built-in role (`lib/config/applyPreset.ts`). From
then on the seeder reconciles only the identity fields — name, description,
rank, `grantsAllPermissions` — and leaves grants exactly as the deployment left
them. Where the flag is false, grants are reconciled in full, **additions and
removals**, so a permission a later release adds to MANAGER actually reaches
deployments that never customised MANAGER. That full reconcile is deliberate:
without it the only options are "new permissions never land" or "a deliberate
revocation silently reappears at the next deploy", and both are wrong.

### The guard

```ts
export default requirePermission("payment.refund", handler); // Pages Router
export const refund = permissionProcedure("payment.refund").mutation(); // tRPC
```

Both are thin wrappers over `resolvePermissionAccess()` in
`lib/auth/permissionResolver.ts` — one shared function on every path
(CLAUDE.md rule 42), so the two routers cannot drift.

Rules preserved from `requireAuthWithRole`, by construction rather than by
copy: `decidePermissionAccess` and `decideRoleAccess` both call the same
`resolveEffectiveRole()` and `applyBootstrapSafeguard()` in `roleDecision.ts`.

- **Resolved from the database, never the JWT.** The staff row (role, roleId,
  `isActive`) is read per request. A session's role is stale the moment someone
  is re-roled and says nothing about `isActive`.
- **No active staff row means no access** — not a default of DESIGNER.
- **Impersonation** is honoured only for a real SUPER_ADMIN/ADMIN and only ever
  _reduces_ privilege. An ADMIN impersonating SUPER_ADMIN is an ADMIN.
- **Bootstrap safeguard** still fires: a denied check passes while NO active
  privileged staff exist, so the first user can promote themselves.
- **Enum fallback**: `roleId = null` resolves under the enum value as a role
  key — the database grant table first, falling back to
  `permissionsForBuiltInRole()` only for a key the table does not carry. This is
  what makes the route sweep adoptable one route at a time.

**Caching.** The grant table (every `Role` plus its `RolePermission` rows) is
cached for **30 seconds** with explicit invalidation — `invalidateRoleGrantCache()`,
called by `syncBuiltInRoles()`, the Roles GUI's REST routes
(`pages/api/admin/roles/`) and `applyPreset()`, and required of every future
write path. The staff row is deliberately **not** cached; staleness there is the security bug
the catalog header describes. Worst-case staleness for a grant change is
therefore **30 seconds**, and only for a change made by a _different_ process
(a second container, a psql session, a one-off migrate container). A change made
in-process is visible immediately.

### Not done yet (each is its own change)

- Sweeping the last 121 routes onto `requirePermission`. Only some are blocked
  on a missing capability — the buyer-drafts workbench is purchasing work behind
  an ADMIN-only guard, and every `purchasing.*` key admits MANAGER, so none is
  admissible. Others are simply unswept: the `api/accounting/*` and
  `api/service/*` routes sit on `requireAuthWithRole(["MANAGER", "ADMIN"])` and
  the capabilities they want (`accounting.read`/`accounting.post`,
  `service.read`/`service.write`) already exist.
- **Card** filtering inside a hub still uses `roles` arrays. Nav no longer does.
- Dropping the `StaffRole` enum.

## Roles

Nav access is not a property of a role any more — it is what the role's grants
earn (`getVisibleNavItems`), so the column below is an OUTPUT of the grants
shipped in `BUILT_IN_ROLES`, asserted item-for-item in `navPermissions.test.ts`;
a deployment that edits those grants changes the menu, and a disabled feature
module hides its item on top.

| Role        | Nav Access (from the shipped grants)                                                    | Notes                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SUPER_ADMIN | Every item                                                                              | Owner-only tier above ADMIN. Sees `/app/admin/reports/commission-tiers` (rate schedule the owner pays per salesperson). Auto-promotes through any ADMIN gate. Holds every permission through the `"*"` wildcard. |
| ADMIN       | Every item                                                                              | Granted every permission in the catalog EXCEPT `admin.impersonate` — an explicit grant list, not a bypass. Database backup, roles and query builder are ADMIN-gated.                                             |
| MANAGER     | Sales, Service, Purchasing, Warehouse, Inventory, Reports, Helpdesk, Time, Admin, Tools | Hub page card filtering still applies, and many `/app/admin/*` sub-pages gate on `["ADMIN"]` alone (see Card Filtering below).                                                                                   |
| DESIGNER    | Sales, Service, Purchasing, Inventory, Reports, Helpdesk, Time, Tools                   | Redirects from `/app` to `/app/sales`. On the Reports hub, sees only the 2 cards that carry no `roles` filter.                                                                                                   |
| REGISTER    | Sales, Inventory, Time, Tools                                                           | POS, till, gift cards, returns                                                                                                                                                                                   |
| WAREHOUSE   | Sales, Service, Purchasing, Warehouse, Inventory, Helpdesk, Time, Tools                 | No Reports, no Admin. Service and Helpdesk are deliberate — WAREHOUSE holds `service.read`/`service.write`.                                                                                                      |
| MARKETING   | Sales, Reports, Time, Tools                                                             | Holds `customer.read` and not `sales.read`; Sales is there because Customers lives under it.                                                                                                                     |
| INSTALLER   | Sales, Service, Warehouse, Helpdesk, Time                                               | Used to sign in to an empty menu (no `NavPermission` default existed); its grants now produce one.                                                                                                               |

## The `isDesigner` flag — report inclusion, not auth (added 2026-05-29)

`StaffMember.isDesigner` (Boolean, default false; the migration history has since been squashed, so the column and its default now live in `0_init`) is **separate from the auth `role`**. It controls who appears on **designer-based sales + commission reports**, so a selling MANAGER can be included and a former designer excluded without changing their login role. It grants no permissions — it's a reporting dimension only.

- Toggle: `/app/admin/staff` edit form ("Show on designer-based sales & commission reports"); persisted via `PATCH /api/staff/[id]`, which is gated on `staff.manage`.
- Filter: `GET /api/staff?isDesigner=true` (designer pickers), `listPeriodConfirmationStatus` (pay-period grid), and the Team Commission view (`designersOnly`).
- See `docs/domains/commission.md` "The `isDesigner` staff flag" for the full surface list.

## SUPER_ADMIN — owner-only tier (added 2026-05-19)

Sits strictly above ADMIN. Reserved for the owner (Goetch Stone). The role exists so commission-tier data (the rate schedule the owner pays salespeople) can ship in the ERP without being visible to anyone else, including ADMIN-level staff.

Key invariants:

- **Auto-promotion over ADMIN gates** — any `["ADMIN"]` check passes for SUPER_ADMIN. The live logic is `decideRoleAccess()` in `lib/auth/roleDecision.ts`, which appends SUPER_ADMIN to any allow-list naming ADMIN. No need to spell SUPER_ADMIN out everywhere; ADMIN is implied. There is deliberately NO equivalent case on the PERMISSION path — SUPER_ADMIN holds everything through the wildcard instead.
- **PRIVILEGED_ROLES sets** — when an API needs "any privileged role," it lists `["SUPER_ADMIN", "ADMIN", "MANAGER"]` explicitly. See the privileged-count queries in `lib/auth/requireAuth.ts`, `lib/auth/requirePage.ts`, `lib/auth/permissionResolver.ts` and `server/trpc/trpc.ts`, feeding the bootstrap safeguard in `roleDecision.ts`.
- **Impersonation** — SUPER_ADMIN can impersonate too (same path as ADMIN); both `lib/auth/roleDecision.ts:resolveEffectiveRole()` and `api/admin/impersonate.ts` accept either role.
- **Card filtering** — `CardGrid` (and the unused Pages-Router `CardGridPageLayout`) has a SUPER_ADMIN bypass (`if (effectiveRole === "SUPER_ADMIN") return true;`) so any hub card is visible without needing to be listed explicitly.
- **Owner-only report** — `app/(dashboard)/app/admin/reports/commission-tiers/page.tsx` calls `requirePage(["SUPER_ADMIN"])` (not promoted from ADMIN). Direct-URL only; not surfaced in any hub.

When adding a new SUPER_ADMIN-only feature: gate on `["SUPER_ADMIN"]` exactly (no auto-promotion FROM ADMIN). When adding a new ADMIN-only feature: list `["ADMIN"]` and rely on the auto-promotion to cover SUPER_ADMIN.

## SUPER_ADMIN vs ADMIN vs MANAGER

| Capability                                                      | SUPER_ADMIN        | ADMIN | MANAGER |
| --------------------------------------------------------------- | ------------------ | ----- | ------- |
| Admin hub (`/app/admin`)                                        | Yes                | Yes   | Yes     |
| Commission Tiers report (`/app/admin/reports/commission-tiers`) | **Yes**            | No    | No      |
| Database backup/restore                                         | Yes                | Yes   | No      |
| Roles & permissions management (`/app/admin/setup/roles`)       | Yes                | Yes   | No      |
| Query builder                                                   | Yes                | Yes   | No      |
| Change staff roles                                              | **No** (see below) | Yes   | No      |
| Assign ADMIN role                                               | **No** (see below) | Yes   | No      |
| Assign SUPER_ADMIN role                                         | **No** (see below) | Yes   | No      |
| Impersonate other roles                                         | Yes                | Yes   | No      |

**The three role-change rows are a bug, not a design.** `PATCH /api/staff/[id]`
compares the caller's own `StaffMember.role` against the literal `"ADMIN"`
(`pages/api/staff/[id].ts:58` and `:63`) with no SUPER_ADMIN auto-promotion, so a
real SUPER_ADMIN gets 403 on any role change while an ADMIN can hand out
SUPER_ADMIN.

**Last-ADMIN safeguard**: the same route (`pages/api/staff/[id].ts:67-76`)
refuses a role change away from an ADMIN or SUPER_ADMIN target when
`count(role: "ADMIN", isActive: true) <= 1`, returning 400 — the count is of
`ADMIN` rows only, so a SUPER_ADMIN does not satisfy it.

## Impersonation

SUPER_ADMIN and ADMIN users can temporarily view the app as any other role via the "View as..." dropdown in the top nav. This sets a cookie (`sh-impersonate`) that is read on every authorization path — `requirePage`, `requireAuthWithRole`, `requirePermission`/`permissionProcedure`, `roleProcedure`, the nav (`TopNav`/`AppNav`), and `CardGrid`. An amber banner shows the active impersonation with a "Stop Impersonating" button.

- API endpoint: `POST /api/admin/impersonate` (sets or clears cookie; accepts both SUPER_ADMIN and ADMIN as the real role). It only accepts six roles — DESIGNER, REGISTER, MANAGER, WAREHOUSE, INSTALLER, MARKETING (`pages/api/admin/impersonate.ts` `VALID_ROLES`) — so ADMIN and SUPER_ADMIN cannot be impersonated at all.
- Hook: `useEffectiveRole()` in `lib/hooks/useEffectiveRole.ts` (reads cookie client-side)
- Cookie expires after 4 hours automatically
- The impersonation checks the user's real DB role is SUPER_ADMIN or ADMIN before applying -- it cannot be spoofed by setting the cookie manually
- Impersonation affects: nav items, card filtering, page access (server redirects), and API role checks
- Impersonation can only ever _reduce_ privilege (`resolveEffectiveRole` in `roleDecision.ts`), and the endpoint's allow-list names neither ADMIN nor SUPER_ADMIN, so there is no way to view the commission-tiers report by impersonating up

## Navigation

The menu is derived from permissions. Each entry in `NAV_ITEMS` (`lib/auth/navPermissions.ts`) names the permission keys that make that destination worth opening, and `getVisibleNavItems()` filters on the keys the viewer holds. Feature modules apply on top: a module switched off in `AppSettings.features` hides its item regardless of permission. Nothing bypasses the derivation, including ADMIN — SUPER_ADMIN sees every item because it holds every permission, not because of a special case.

The `NavPermission` table is gone — dropped by migration `20260807120000_drop_nav_permission`, along with the `/admin/setup/permissions` page and its `pages/api/admin/permissions` route. Nav is presentation, not enforcement: the viewer's permission keys ride on the NextAuth session as a display convenience, and the grant table read per request by `permissionResolver.ts` is what actually admits a request.

## Page-Level Auth

Every App Router page calls `await requirePage()` (`lib/auth/requirePage.ts`) in its server component. The role list is POSITIONAL, not an option: `requirePage(["MANAGER", "ADMIN"])`; sensitive pages pass `["ADMIN"]`. Four pages instead gate on a capability via `requirePage(undefined, { permission })` — Purchasing, Warehouse, Helpdesk and Time, the pages whose nav entry is derived from that same key, so the link and the page cannot disagree. `requirePage` resolves through the same `decideRoleAccess`/`resolvePermissionAccess` helpers as the API guards. The bootstrap safeguard skips role enforcement until at least one active signed-in privileged user (SUPER_ADMIN/ADMIN/MANAGER) exists.

The only Pages Router `.tsx` files left are `_app`, `_document` and the three `/auth/*` screens.

## Card Filtering

`CardGrid` supports a `roles` prop (and an optional `feature` key) on each card item. Cards without `roles` are visible to all authenticated users.

Currently restricted:

- Sales hub: only Customers is visible to all. Pipeline, Quotes, Orders (ADMIN/MANAGER/DESIGNER). Invoices, B2B Proposals (ADMIN/MANAGER). POS, Gift Card Sale, Till (ADMIN/REGISTER). New Quote, Returns, House Calls, Interactions, Leads, HD Import (ADMIN only).
- Order detail: Payment links and Customer Portal hidden from DESIGNER (MANAGER/ADMIN only).
- Warehouse hub: Overview, Receiving, Transfers, Returns (ADMIN/WAREHOUSE only — hidden from MANAGER).
- Reports hub: 10 of the 29 cards are (ADMIN/MANAGER), including Pipeline Opportunity; Opportunities is (ADMIN/MARKETING). Tax Summary, Till Reconciliation (ADMIN only). Mailchimp Campaign + Activity (ADMIN/MARKETING only). **Wealth Insights (ADMIN/MARKETING only — not MANAGER).**
- Admin hub: Import Tools, Gift Cards, System Tools, Data Exports (ADMIN only). Setup, Vendor Pricing, Sales Goals, Monthly Pct, Salesperson Corrections visible to MANAGER.
- Setup page: Database Backup and Roles (ADMIN only)
- Tools page: Query Builder (ADMIN only)

## Wealth Data Visibility

Wealth data (net worth, tier, signals) is **ADMIN and MARKETING only**. MANAGER does NOT see wealth data.

Enforcement must be at BOTH layers (a page-level check alone is insufficient — the data would still leak via network inspector):

1. **Page/card auth**: `["ADMIN", "MARKETING"]` on `requirePage`, report cards, and conditional UI
2. **API response shape**: omit `wealthTier` (and related fields) from the response body when session role is not ADMIN/MARKETING. See `api/sales/pipeline/index.ts` for the pattern.

Designers and managers can see the **lead score tier** (HOT/WARM/COOL/NEW) — safe because it reveals no wealth details even when wealth data contributed to the score. See `lib/leadScore.ts`.

## Designer Redirect

Designers hitting `/app` are redirected to `/app/sales` in `app/(dashboard)/app/page.tsx`, after `requirePage()` resolves their role. The dashboard (traffic, up-board, sales summary) is manager-facing.

## Up-Board

Staff rotation board for customer assignment. Managed in `lib/upboard.ts`. Shifts auto-expire after 9 hours. `compactAndPromote()` removes gaps. Each store location has its own independent board.

## Key Files

- `lib/auth/permissionCatalog.ts` -- the permission vocabulary + built-in roles
- `lib/auth/permissionResolver.ts` -- the one "may this user do X" resolver, grant-table cache
- `lib/auth/builtInRoles.ts` -- idempotent built-in role seed + orphan-key check
- `lib/auth/roleDecision.ts` -- pure decisions; impersonation + bootstrap rules
- `lib/auth/navPermissions.ts` -- the nav vocabulary; menu derived from permissions
- `lib/auth/requireAuth.ts` -- API auth wrappers (`requireAuthWithRole`, `requirePermission`)
- `lib/auth/requirePage.ts` -- App Router page gate (positional role list, or a capability)
- `lib/auth/roleAdmin.ts` -- wire types + serialization shared by the Roles GUI and its API
- `lib/auth/withAuth.ts` -- DEAD. Pages-Router SSR auth HOC; zero importers, and it still holds a second, weaker copy of the role/impersonation rules. Do not extend it.
- `server/trpc/trpc.ts` -- `roleProcedure` / `permissionProcedure`
- `lib/hooks/useEffectiveRole.ts` -- client-side hook for impersonation-aware role
- `pages/api/admin/impersonate.ts` -- set/clear impersonation cookie
- `pages/api/admin/roles/` -- Roles GUI's REST contract, gated on `staff.manage`
- `lib/upboard.ts` -- up-board rotation logic
- `app/(dashboard)/app/admin/setup/roles/` -- build and edit roles (page gate: ADMIN)

## Verification Checklist

- [ ] `npm test -- navPermissions` passes
- [ ] Every page calls `requirePage()` (or explains why not)
- [ ] New pages pass a `roles` list, or a `permission`, if restricted
- [ ] New report cards have `roles` prop set
- [ ] A new nav destination has an entry in `NAV_ITEMS` naming a real permission
- [ ] Designer redirect verified (no access to dashboard)

## Test Coverage

Covered: `navPermissions.test.ts` (each built-in role's exact menu derived from
its grants, a custom role's menu, feature gating being orthogonal, impersonation
narrowing only),
`roleDecision.test.ts` + `permissionDecision.test.ts` (impersonation cannot escalate,
bootstrap safeguard, the wildcard covering a permission no row mentions),
`permissionResolver.test.ts` (grant-table build, rank floor, cache TTL +
invalidation race, `StaffRole` enum fallback), `rolePermissionSchema.test.ts`
(the enum ↔ `BUILT_IN_ROLES` both-directions tripwire, migration backfill scan),
`integration/rbacFoundation.integration.test.ts` (seeder idempotency,
`grantsCustomized`, orphan keys, `requirePermission` end to end on the refund
route).

Gaps: `upboard.ts` logic untested (Prisma-dependent, needs refactoring to test).
The migration's `roleId` backfill is never executed by the suite — integration
tests build their schema with `prisma db push`, not `migrate deploy` — so it is
covered by a source scan only.

## withAuth helper extraction (2026-05-20) — historical

Kept for the reasoning, not as a description of the live path. Nothing imports
`lib/auth/withAuth.ts` any more (pages moved to `requirePage`), and the rules
below now live in `lib/auth/roleDecision.ts`, which every router shares.

`lib/auth/withAuth.ts` was previously a single 60-line function with cognitive complexity 18. Refactored into three pure helpers:

- `resolveEffectiveRole(session, ctx)` — real role + impersonation cookie → effective role for the check
- `isAuthorized(userRole, allowedRoles)` — direct match OR SUPER_ADMIN-over-ADMIN auto-promotion
- `hasAnyPrivilegedUser()` — bootstrap-safeguard DB count; fails open (allows access) on DB error

Behavior was identical to the prior monolith. If you're working on auth-related code, call the `roleDecision.ts` helpers — not these.

---

Last verified: 2026-05-20

## Password reset + my-account (2026-06-10)

Self-service for the local (credentials) sign-in method — every surface 404s
when `AUTH_LOCAL_ENABLED` is off:

- **Forgot password**: `/auth/forgot-password` (link on the login form) →
  `POST /api/auth/forgot-password` (rate-limited 5/15min). ALWAYS answers
  `{ ok: true }` — no account enumeration; the reset email only goes out for
  an active staff email. Token model `PasswordResetToken` (migration
  `20260610c`): only the SHA-256 of the raw token is stored, 1-hour expiry,
  single-use, and a new request voids prior open tokens.
  `lib/auth/passwordReset.ts`; email template `passwordResetEmail` through
  the durable queue.
- **Reset page**: `/auth/reset-password?token=...` →
  `POST /api/auth/reset-password` — consume + set the new scrypt hash
  atomically; the error never distinguishes missing/expired/used.
- **My Account**: `/app/account` (any signed-in user) — identity summary +
  change password via tRPC `account.changePassword` (proof of the current
  password required when one exists; an OAuth-only account may set its
  first). Acts only on the caller's own staff record.

Real-DB proof: `__tests__/integration/passwordReset.integration.test.ts`
(enumeration safety, single-use, expiry, supersession, hash verifies).
