# Staff & Auth

Role-based access control, navigation permissions, up-board staff rotation, onboarding tour.

## Permissions: what is and is NOT enforced (2026-08-06)

**Read this first.** Everything below this section describes the `StaffRole`
enum, and that is still how almost all authorization actually works. The
permission layer exists, is wired end to end, and gates exactly **one** route.
Do not read the presence of `Role`, `RolePermission` and a permission catalog
as "permissions are live".

| Piece | State |
|---|---|
| `PERMISSIONS` / `BUILT_IN_ROLES` (`lib/auth/permissionCatalog.ts`) | Complete — 45 permissions across 14 domains, 8 built-in roles |
| `Role`, `RolePermission`, `StaffMember.roleId` | Exist, migrated, backfilled |
| Built-in role seed | Runs on every deploy |
| `requirePermission()` (Pages Router) | Exists; **1 route uses it** |
| `permissionProcedure()` (tRPC) | Exists; **0 procedures use it** |
| The other **334** Pages Router API routes | Still `requireAuthWithRole([...])` on the enum |
| Page-level `withAuth`, nav, card filtering | Still the enum, untouched |
| Custom-role admin GUI | Does not exist |
| `StaffRole` enum | Still present, still authoritative for those 334 routes |

The one converted route is `POST /api/sales/orders/[id]/refunds`, gated on
`payment.refund`. It was chosen because the PR #67 audit found it was the
single route with no authorization at all — any signed-in account could refund
a card — and it moved from the stopgap `requireAuthWithRole(["MANAGER", "ADMIN"])`
to the capability it was really asking for. The set of people who can call it
is unchanged.

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
  participates instead of ranking 0. A row may *raise* a rank, never lower one
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
built-in role's grants (the future admin GUI sets it; nothing else does). From
then on the seeder reconciles only the identity fields — name, description,
rank, `grantsAllPermissions` — and leaves grants exactly as the deployment left
them. Where the flag is false, grants are reconciled in full, **additions and
removals**, so a permission a later release adds to MANAGER actually reaches
deployments that never customised MANAGER. That full reconcile is deliberate:
without it the only options are "new permissions never land" or "a deliberate
revocation silently reappears at the next deploy", and both are wrong.

### The guard

```ts
export default requirePermission("payment.refund", handler);            // Pages Router
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
  *reduces* privilege. An ADMIN impersonating SUPER_ADMIN is an ADMIN.
- **Bootstrap safeguard** still fires: a denied check passes while NO active
  privileged staff exist, so the first user can promote themselves.
- **Enum fallback**: `roleId = null` resolves through
  `permissionsForBuiltInRole(staffMember.role)`. This is what makes the route
  sweep adoptable one route at a time.

**Caching.** The grant table (every `Role` plus its `RolePermission` rows) is
cached for **30 seconds** with explicit invalidation — `invalidateRoleGrantCache()`,
called by `syncBuiltInRoles()` and required of every future write path. The
staff row is deliberately **not** cached; staleness there is the security bug
the catalog header describes. Worst-case staleness for a grant change is
therefore **30 seconds**, and only for a change made by a *different* process
(a second container, a psql session, a one-off migrate container). A change made
in-process is visible immediately.

### Not done yet (each is its own change)

- Sweeping the last 129 routes onto `requirePermission`. Each is blocked on the
  same thing: no capability names what the route does (the buyer-drafts
  workbench is purchasing work behind an ADMIN-only guard, and every
  `purchasing.*` key admits MANAGER, so none is admissible).
- **Card** filtering inside a hub still uses `roles` arrays. Nav no longer does.
- Dropping the `StaffRole` enum.

## Roles

| Role | Nav Access | Notes |
|------|-----------|-------|
| SUPER_ADMIN | Everything + owner-only reports | Owner-only tier above ADMIN. Sees `/admin/reports/commission-tiers` (rate schedule the owner pays per salesperson). Auto-promotes through any ADMIN gate. |
| ADMIN | Everything except owner-only | Superuser. Bypasses all permission checks. Sole access to database, permissions, query builder. |
| MANAGER | Sales, Service, Purchasing, Warehouse, Inventory, Reports, Admin, Tools | Respects DB overrides and hub page card filtering. Restricted sub-pages (see Card Filtering below). |
| DESIGNER | Sales, Reports | Redirects from `/` to `/sales`. Sees only 3 reports. |
| REGISTER | Sales | POS, till, gift cards, returns |
| WAREHOUSE | Service, Purchasing, Warehouse, Inventory | No Sales, no Reports, no Admin, no Tools |
| MARKETING | Sales, Reports | Sales: Customers only. Reports: Wealth Insights, Mailchimp, Customer Report |
| INSTALLER | None defined | Exists in enum but no nav defaults |

## The `isDesigner` flag — report inclusion, not auth (added 2026-05-29)

`StaffMember.isDesigner` (Boolean, default false; backfilled true for existing `role = DESIGNER` via migration `20260529c_staff_is_designer`) is **separate from the auth `role`**. It controls who appears on **designer-based sales + commission reports**, so a selling MANAGER can be included and a former designer excluded without changing their login role. It grants no permissions — it's a reporting dimension only.

- Toggle: `/admin/staff` edit form ("Show on designer-based sales & commission reports"); persisted via `PATCH /api/staff/[id]`.
- Filter: `GET /api/staff?isDesigner=true` (designer pickers), `listPeriodConfirmationStatus` (pay-period grid), and the Team Commission view (`designersOnly`).
- See `docs/domains/commission.md` "The `isDesigner` staff flag" for the full surface list.

## SUPER_ADMIN — owner-only tier (added 2026-05-19)

Sits strictly above ADMIN. Reserved for the owner (Goetch Stone). The role exists so commission-tier data (the rate schedule the owner pays salespeople) can ship in the ERP without being visible to anyone else, including ADMIN-level staff.

Key invariants:

- **Auto-promotion over ADMIN gates** — any `roles: ["ADMIN"]` check passes for SUPER_ADMIN. Logic lives in `lib/auth/withAuth.ts:isAuthorized()` after the 2026-05-20 helper extraction. No need to spell SUPER_ADMIN out everywhere; ADMIN is implied.
- **PRIVILEGED_ROLES sets** — when an API needs "any privileged role," it lists `["SUPER_ADMIN", "ADMIN", "MANAGER"]` explicitly. See `lib/auth/requireAuth.ts` + the bootstrap safeguard in `withAuth.ts:hasAnyPrivilegedUser()`.
- **Impersonation** — SUPER_ADMIN can impersonate too (same path as ADMIN); both `lib/auth/withAuth.ts:resolveEffectiveRole()` and `api/admin/impersonate.ts` accept either role.
- **Card filtering** — `CardGridPageLayout` has a SUPER_ADMIN bypass (`if (effectiveRole === "SUPER_ADMIN") return true;`) so any hub card is visible without needing to be listed explicitly.
- **Owner-only report** — `pages/admin/reports/commission-tiers.tsx` gates on `roles: ["SUPER_ADMIN"]` (not promoted from ADMIN). Direct-URL only; not surfaced in any hub.

When adding a new SUPER_ADMIN-only feature: gate on `["SUPER_ADMIN"]` exactly (no auto-promotion FROM ADMIN). When adding a new ADMIN-only feature: list `["ADMIN"]` and rely on the auto-promotion to cover SUPER_ADMIN.

## SUPER_ADMIN vs ADMIN vs MANAGER

| Capability | SUPER_ADMIN | ADMIN | MANAGER |
|-----------|---|---|---|
| All admin pages | Yes | Yes | Yes |
| Commission Tiers report (`/admin/reports/commission-tiers`) | **Yes** | No | No |
| Database backup/restore | Yes | Yes | No |
| Nav permissions management | Yes | Yes | No |
| Query builder | Yes | Yes | No |
| Change staff roles | Yes | Yes | No |
| Assign ADMIN role | Yes | Yes | No |
| Assign SUPER_ADMIN role | **Yes** | No | No |
| Impersonate other roles | Yes | Yes | No |

**Last-ADMIN safeguard**: The API (`api/staff/[id].ts`) prevents removing the last active ADMIN or SUPER_ADMIN. If a role change would reduce the privileged count to zero, it returns 400.

## Impersonation

SUPER_ADMIN and ADMIN users can temporarily view the app as any other role via the "View as..." dropdown in the top nav. This sets a cookie (`sh-impersonate`) that overrides role checks in `withAuth`, `requireAuthWithRole`, `TopNav`, and `CardGridPageLayout`. An amber banner shows the active impersonation with a "Stop Impersonating" button.

- API endpoint: `POST /api/admin/impersonate` (sets or clears cookie; accepts both SUPER_ADMIN and ADMIN as the real role)
- Hook: `useEffectiveRole()` in `lib/hooks/useEffectiveRole.ts` (reads cookie client-side)
- Cookie expires after 4 hours automatically
- The impersonation checks the user's real DB role is SUPER_ADMIN or ADMIN before applying -- it cannot be spoofed by setting the cookie manually
- Impersonation affects: nav items, card filtering, page access (SSR redirects), and API role checks
- SUPER_ADMIN impersonating ADMIN still does NOT see the commission-tiers report (the page gates on the *effective* role)

## Navigation Permissions

Default permissions in `lib/auth/navPermissions.ts`. Can be overridden per-role via `NavPermission` DB records managed at `/admin/setup/permissions` (ADMIN-only).

Only ADMIN bypasses DB overrides. All other roles (including MANAGER) respect DB-configured permissions.

## Page-Level Auth

Every page must export `getServerSideProps = withAuth()`. Role-restricted pages use `withAuth(undefined, { roles: ["MANAGER", "ADMIN"] })`. Sensitive pages use `roles: ["ADMIN"]`. The bootstrap safeguard skips role enforcement until at least one active signed-in ADMIN or MANAGER exists.

## Card Filtering

`CardGridPageLayout` supports a `roles` prop on each card item. Cards without `roles` are visible to all authenticated users.

Currently restricted:

- Sales hub: Pipeline, Quotes, Orders, Customers visible to all. B2B Proposals (ADMIN/MANAGER). New Quote, POS, Gift Card, Till, Returns (ADMIN/REGISTER). House Calls, Interactions, Leads, HD Import (ADMIN only).
- Order detail: Payment links and Customer Portal hidden from DESIGNER (MANAGER/ADMIN only).
- Warehouse hub: Overview, Receiving, Transfers, Returns (ADMIN/WAREHOUSE only — hidden from MANAGER).
- Reports hub: 5 opportunity reports (ADMIN/MANAGER). Tax Summary, Till Reconciliation (ADMIN only). Mailchimp Campaign + Activity (ADMIN/MARKETING only). **Wealth Insights (ADMIN/MARKETING only — not MANAGER).**
- Admin hub: Import Tools, Gift Cards, System Tools, Data Exports (ADMIN only). Setup, Vendor Pricing, Sales Goals, Monthly Pct, Salesperson Corrections visible to MANAGER.
- Setup page: Database Backup and Nav Permissions (ADMIN only)
- Tools page: Query Builder (ADMIN only)

## Wealth Data Visibility

Wealth data (net worth, tier, signals) is **ADMIN and MARKETING only**. MANAGER does NOT see wealth data.

Enforcement must be at BOTH layers (a page-level check alone is insufficient — the data would still leak via network inspector):

1. **Page/card auth**: `roles: ["ADMIN", "MARKETING"]` on `withAuth`, report cards, and conditional UI
2. **API response shape**: omit `wealthTier` (and related fields) from the response body when session role is not ADMIN/MARKETING. See `api/sales/pipeline/index.ts` for the pattern.

Designers and managers can see the **lead score tier** (HOT/WARM/COOL/NEW) — safe because it reveals no wealth details even when wealth data contributed to the score. See `lib/leadScore.ts`.

## Designer Redirect

Designers hitting `/` are redirected to `/sales` via `getServerSideProps` in `pages/index.tsx`. The dashboard (traffic, up-board, sales summary) is manager-facing.

## Onboarding Tour

`components/onboarding/WelcomeTour.tsx` shows role-specific slides on first login. Each role has its own version number and localStorage key (`sh-tour-DESIGNER`, `sh-tour-MANAGER`). Bump the version for a specific role in `TOUR_VERSIONS` to re-trigger only for that role.

Current tour content:

- **DESIGNER** (v2): Welcome, Pipeline (with quote date), Lead Score Badges, Quotes & Orders, Reports
- **MANAGER** (v4): Lead Scoring, Pipeline Drilldown + Notes, Wealth Data Privacy (heads-up about removed access), Pipeline Card Improvements, Sales Opportunity Reports, Delivery Dispatch, Customer Levels
- **ADMIN** (v4): Same as MANAGER

To add a new feature announcement: add a slide to the role's array, bump that role's version in `TOUR_VERSIONS`.

## Up-Board

Staff rotation board for customer assignment. Managed in `lib/upboard.ts`. Shifts auto-expire after 9 hours. `compactAndPromote()` removes gaps. Each store location has its own independent board.

## Key Files

- `lib/auth/permissionCatalog.ts` -- the permission vocabulary + built-in roles
- `lib/auth/permissionResolver.ts` -- the one "may this user do X" resolver, grant-table cache
- `lib/auth/builtInRoles.ts` -- idempotent built-in role seed + orphan-key check
- `lib/auth/roleDecision.ts` -- pure decisions; impersonation + bootstrap rules
- `lib/auth/navPermissions.ts` -- nav permission defaults and resolution
- `lib/auth/requireAuth.ts` -- API auth wrappers (`requireAuthWithRole`, `requirePermission`)
- `lib/auth/withAuth.ts` -- SSR auth HOC with role checking (impersonation-aware)
- `lib/hooks/useEffectiveRole.ts` -- client-side hook for impersonation-aware role
- `pages/api/admin/impersonate.ts` -- set/clear impersonation cookie
- `lib/upboard.ts` -- up-board rotation logic
- `components/onboarding/WelcomeTour.tsx` -- designer onboarding
- `app/admin/setup/roles/` -- build and edit roles

## Verification Checklist

- [ ] `npm test -- navPermissions` passes
- [ ] Every page exports `getServerSideProps = withAuth()` (or explains why not)
- [ ] New pages include `roles` filter if role-restricted
- [ ] New report cards have `roles` prop set
- [ ] Designer redirect verified (no access to dashboard)
- [ ] Tour version bumped if new designer-facing features added

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

## withAuth helper extraction (2026-05-20)

`lib/auth/withAuth.ts` was previously a single 60-line function with cognitive complexity 18. Refactored into three pure helpers:

- `resolveEffectiveRole(session, ctx)` — real role + impersonation cookie → effective role for the check
- `isAuthorized(userRole, allowedRoles)` — direct match OR SUPER_ADMIN-over-ADMIN auto-promotion
- `hasAnyPrivilegedUser()` — bootstrap-safeguard DB count; fails open (allows access) on DB error

Behavior is identical to the prior monolith. If you're working on auth-related code, prefer extending or calling these helpers over inlining new role logic into the wrapper body.

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
