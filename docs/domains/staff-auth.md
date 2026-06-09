# Staff & Auth

Role-based access control, navigation permissions, up-board staff rotation, onboarding tour.

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

## SUPER_ADMIN — owner-only tier (added 2026-05-19, PR #296)

Sits strictly above ADMIN. Reserved for the owner (Goetch Stone). The role exists so commission-tier data (the rate schedule the owner pays salespeople) can ship in the ERP without being visible to anyone else, including ADMIN-level staff.

Key invariants:

- **Auto-promotion over ADMIN gates** — any `roles: ["ADMIN"]` check passes for SUPER_ADMIN. Logic lives in `lib/auth/withAuth.ts:isAuthorized()` after the 2026-05-20 helper extraction (PR #308). No need to spell SUPER_ADMIN out everywhere; ADMIN is implied.
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

- `lib/auth/navPermissions.ts` -- nav permission defaults and resolution
- `lib/auth/requireAuth.ts` -- API auth wrapper (impersonation-aware)
- `lib/auth/withAuth.ts` -- SSR auth HOC with role checking (impersonation-aware)
- `lib/hooks/useEffectiveRole.ts` -- client-side hook for impersonation-aware role
- `pages/api/admin/impersonate.ts` -- set/clear impersonation cookie
- `lib/upboard.ts` -- up-board rotation logic
- `components/onboarding/WelcomeTour.tsx` -- designer onboarding
- `pages/admin/setup/permissions.tsx` -- permission management UI

## Verification Checklist

- [ ] `npm test -- navPermissions` passes
- [ ] Every page exports `getServerSideProps = withAuth()` (or explains why not)
- [ ] New pages include `roles` filter if role-restricted
- [ ] New report cards have `roles` prop set
- [ ] Designer redirect verified (no access to dashboard)
- [ ] Tour version bumped if new designer-facing features added

## Test Coverage

Covered: `navPermissions.test.ts` (role filtering, DB overrides, defaults, ADMIN bypass)

Gaps: `upboard.ts` logic untested (Prisma-dependent, needs refactoring to test)

## withAuth helper extraction (2026-05-20, PR #308)

`lib/auth/withAuth.ts` was previously a single 60-line function with cognitive complexity 18. Refactored into three pure helpers:

- `resolveEffectiveRole(session, ctx)` — real role + impersonation cookie → effective role for the check
- `isAuthorized(userRole, allowedRoles)` — direct match OR SUPER_ADMIN-over-ADMIN auto-promotion
- `hasAnyPrivilegedUser()` — bootstrap-safeguard DB count; fails open (allows access) on DB error

Behavior is identical to the prior monolith. If you're working on auth-related code, prefer extending or calling these helpers over inlining new role logic into the wrapper body.

---
Last verified: 2026-05-20
