# Staff & Auth

Role-based access control, permission-derived navigation, up-board staff rotation.

## Permissions: what is and is NOT enforced (2026-11-21)

**Read this first.** The permission layer is nearly the whole _guarded_ API
surface: of the 503 Pages Router route files that carry a guard, **501 gate on
a capability** (490 through `requirePermission`, 11 through `guardAutomation`)
and **2**, the house-call routes, still gate on the `StaffRole` enum (counted
2026-11-21, after the role-list sweep). Nav is derived from permissions, and hub
cards follow the key of the page each opens (`lib/auth/hubCards.ts`). Every page
gates on a key apart from three that keep a role list while the owner decides
who should open them: the Service dispatch board and the two house-call pages.
So the enum has not gone away.

| Piece                                                              | State                                                                                                                                                                                                        |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PERMISSIONS` / `BUILT_IN_ROLES` (`lib/auth/permissionCatalog.ts`) | Complete — 70 permissions across 14 domains, 15 built-in roles                                                                                                                                               |
| `Role`, `RolePermission`, `StaffMember.roleId`                     | Exist, migrated, backfilled                                                                                                                                                                                  |
| Built-in role seed                                                 | Runs on every deploy                                                                                                                                                                                         |
| `requirePermission()` (Pages Router)                               | **490 route files use it**, and 11 more through `guardAutomation`                                                                                                                                            |
| `permissionProcedure()` (tRPC)                                     | Every gated procedure. `reports`, `billing` and `clientPortal` were the last routers on `roleProcedure(...)`; `billing.*` and `clientPortal.generateLink` are Bill customers directly (`accounting.invoice`) |
| The other **2** Pages Router API routes                            | `service/house-calls/index.ts` and `[id].ts`, still `requireAuthWithRole([...])` on the enum                                                                                                                 |
| Nav                                                                | Derived from permissions (`lib/auth/navPermissions.ts`); the `NavPermission` table is dropped                                                                                                                |
| Page-level `requirePage`, card filtering                           | Pages: a key, apart from three (see Page-Level Auth). Cards: the destination page's key in `PAGE_ACCESS`, plus `CARD_KEY_OVERRIDES` (`lib/auth/hubCards.ts`)                                                 |
| Custom-role admin GUI                                              | Ships at `/app/admin/setup/roles`                                                                                                                                                                            |
| `StaffRole` enum                                                   | Still present, still authoritative for those 2 routes and 3 pages                                                                                                                                            |

`sales.clients.manage` (GAP-36) opens other salespeople's client books and the Follow-Ups
report, and assigns clients no one owns. Since 2026-11-21 it is also every salesperson's
Pipeline, and archiving or restoring anyone's quotes, one at a time or in bulk, which were
MANAGER/ADMIN name checks. Built in for Manager and General Manager, and for admins. Seeing what a salesperson
keeps on a client takes `customer.write` or `sales.lead`, so Warehouse, Dispatch, Installer
and Marketing can read a customer without it. `docs/domains/sales-orders.md` has the table.

**The owner tier (`OWNER_ONLY_PERMISSIONS`, `lib/auth/permissionCatalog.ts`).**
The keys SUPER_ADMIN holds through the wildcard and no other built-in role does:
`admin.impersonate`, and since 2026-11-20 `staff.commission-pay` ("See and run
commission and pay"). ADMIN's grant list is derived as every key not in that
set, and the seeder writes it, so the set is the one place the tier is defined
(`__tests__/permissionCatalog.test.ts` fails if a built-in role other than
SUPER_ADMIN gains the commission key). `staff.commission-pay` gates the
Commission and Pay Period Sales screens, their REST and tRPC data, and changing
a staff member's commission plan (`docs/domains/commission.md`). **Who held
these before:** the old gates were `requireAuthWithRole(["SUPER_ADMIN"])` and
`roleProcedure(["SUPER_ADMIN"])`, which match the staff row's `StaffRole` enum
(`resolveRoleListAccess`), so only an active staff member whose enum is
SUPER_ADMIN, plus the bootstrap safeguard (no privileged staff yet). **Now:**
a role holding the key, resolved through the staff row's linked Role (enum
fallback when `roleId` is NULL): the built-in Owner (wildcard) and any role a
store grants it to. No data migration is needed. The one difference: a role of
the store's own marked "grants everything" (`grantsAllPermissions`) now also
holds it, where it did not satisfy the enum check. Under View as, the key is
held only when both the viewed role and the real role hold it, so an Owner
viewing as Administrator is refused, as before.

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

**Which key a route takes (SEC-13, 2026-09-24).** The owner decides who sees
what in Admin → Setup → Roles, so a route takes the key of the screen it serves,
never a list of role names. A route that serves several screens takes **any of
those screens' keys**:

```ts
export default requirePermission(
  { anyOf: ["sales.read", "reporting.read"] },
  handler,
);
```

Granting a role any one of those screens then grants the data behind it, and no
setting has to be kept in step with another. `{ anyOf }` is decided in one pass
inside `decidePermissionAccess` (one staff read; the bootstrap safeguard only
after every key has missed), not by asking once per key. Where one screen needs
less than another, split the route instead of widening the list: the POS reads
its register's open till from `GET /api/registers/[id]` (`pos.operate`) rather
than the till list, and a service case finds a PO through
`/api/service/purchase-order-lookup` (`service.write`) rather than the
purchasing list. Store data is split three ways (SEC-15):

- `/api/store-locations` is the store list: names only, on `staff.self`, because
  Home, which every staff member opens, needs it.
- `/api/store-locations/stock-locations` is the picker, for the three screens
  that choose a stock location.
- `/api/warehouse/locations` is setup detail, for Admin → Stores and Warehouse →
  Locations only.
- `/api/staff/active-store` (`staff.self`) is the viewer's own active store. It
  also answers `taxDistrictConfigured` -- does a sale there resolve a tax
  district -- so POS and New Quote can warn of 0% tax on the key they already
  use, without a wider one (USE-08).

A route that needs different keys per method dispatches on `req.method` to
separate `requirePermission(...)` calls, as `inventory/freeze/index.ts` does.
`permissionKeysExist.test.ts` fails CI on any key a route names that the catalog
does not define.

**Adding a key for data that was open before** (e.g. `reporting.traffic`, "View
store traffic", SEC-13 2026-09-24). A new key must not take anything away on
day one. Put it in every built-in role's `BUILT_IN_ROLES` list that reaches the
data today; `syncBuiltInRoles()` then adds it to built-in roles nobody has
edited. It never touches edited built-ins (`grantsCustomized`) or roles the
deployment built, so a **migration** grants it to those. It has to be a
migration, not a seed step: a seed step runs on every deploy and would grant
the key again after the owner unticks it. Also add it to the roles in
`config/example.yaml`: a `kind: roles` preset replaces a role's grants, so a key
it leaves out is revoked when the preset is applied. `__tests__/config/presets.test.ts`
holds the example to this: its built-in roles may leave out only the keys the
test lists as deliberate revocations (the Designer's View reports and View
cost), and its own roles must hold every key a migration granted every role a
store built (`reporting.traffic`, `customer.address`). The example Designer had
silently dropped Work leads, and Floor Lead lacked Edit customer addresses.

The second key added this way, `inventory.locations.manage` ("Set up stores and
stock locations", SEC-15), shows the other half of "nothing changes on day one".
The old gate was a key **plus a hardcoded role check inside the route**
(`activeStaffRole` must be MANAGER or ADMIN), so the default is the audience
that check actually let through, not every holder of the key. The old setup
actions had two audiences (store writes: Transfer stock + MANAGER/ADMIN; stock
location edits: Adjust inventory), and one switch takes their **union**, so
nobody loses a setup action and the PR names who gains. Its migration grants
the new key to roles holding `inventory.adjust`, or holding
`inventory.transfer` with key ADMIN or MANAGER. Custom roles carry the enum
DESIGNER, so none of them had passed the hardcoded check. One gap: that check
read the staff enum, the migration reads `Role.key`, so staff whose enum and
`roleId` drifted apart before USE-02 are not covered.

**The 2026-11 role-list sweep** moved 64 of the 66 API routes still on a role
list, the role-name checks inside other routes, 57 pages and the `reports`,
`billing` and `clientPortal` routers onto keys. Most went to keys that already
existed. Eleven keys are new, added the same way: each starts
on exactly the built-in roles its lists let through, plus ADMIN by derivation
and the Owner by wildcard. General Manager holds none of them.

| Key                       | Label                                 | Built in for (besides ADMIN and the Owner) | Replaced the role lists on                                                                            |
| ------------------------- | ------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `sales.proposal`          | Work B2B proposals                    | Manager                                    | the two B2B proposal pages and the eight `/api/proposals` routes                                      |
| `customer.trade`          | Set trade accounts and tax exemptions | Manager                                    | `/api/customers/[id]/trade`                                                                           |
| `customer.address`        | Edit customer addresses               | Manager, Designer, Warehouse, Marketing    | `/api/customers/[id]/addresses`                                                                       |
| `customer.wealth`         | See wealth data                       | Marketing                                  | Wealth Insights, Opportunities, and the wealth on the customer page, the Pipeline and the Leads board |
| `payment.return-refund`   | Refund returns                        | Manager, Register, Warehouse               | `/api/returns/[id]/refund`, which also takes Refund payment                                           |
| `accounting.invoice`      | Bill customers directly               | Manager                                    | the four Invoices pages, the `billing` router, `clientPortal.generateLink` and the invoice PDF        |
| `accounting.chart.manage` | Set up the chart of accounts          | Manager                                    | the writes on the five chart-of-accounts routes                                                       |
| `service.setup`           | Set up service                        | Manager                                    | the delivery-zone, installer, case-setting and email-template writes                                  |
| `reporting.management`    | View management reports               | Manager                                    | 17 management reports, page and procedure                                                             |
| `reporting.financial`     | View financial reports                | none                                       | Balance Due Aging, Stale Quote Cleanup, Consignment Summary and Open PO Gaps                          |
| `marketing.lists`         | See customer lists                    | Marketing                                  | the Customer Report and Opportunities, and choosing any salesperson on Sales by Salesperson           |

Migration `20261121120000_grant_role_list_keys` grants them, idempotently, to
the built-in rows by role key, so an edited (`grantsCustomized`) role gets them
too, and grants `customer.address` to every custom role as well: custom-role
staff carry the enum DESIGNER, which the address list admitted. No other key
goes to a custom role, and General Manager gets nothing. The known gap is the
one above: staff whose enum and linked role disagree are now decided by the
linked role. `permissionCatalog.test.ts` pins each key's holders, and
`roleListKeysMigration.integration.test.ts` the migration.

Manager also gains **Post journals** (`accounting.post`), which it needs only for
`journal-entries/[id]` PUT and DELETE (post an entry, mark it exported, delete a
draft), a MANAGER/ADMIN list until then. The grant opens nothing else: the
date-range journal export (`accounting/export-journal.ts`) and the
customer-ledger backfill (`admin/customer-ledger/backfill.ts`,
`customer-ids.ts`) moved from Post journals to Change settings
(`admin.settings`), their screens' key, and the invoice PDF moved from View
accounting to Bill customers directly.

The same migration grants **Manage client books** (`sales.clients.manage`) to
the edited Manager and Administrator rows. It is not new: it entered the
catalog in #96 (2026-11-05) with no migration, so a Manager or Administrator
edited before then never had it. The Pipeline's all-staff view, one
salesperson's board, search across every open quote and archiving or
bulk-archiving anyone's quotes checked the staff enum against MANAGER/ADMIN
until this sweep and now ask for this key, so without the grant those roles
would have lost them. It was the only such key. A key in the catalog at the
first commit existed when every role was created, so an edited role without it
had it unticked; of the seven added since, `reporting.all-salespeople` already
had its migration (`20261118120000`), and the other five gate nothing the sweep
converted. The cost: a Manager or Administrator role an owner unticked it on
after 2026-11-05 gets it back, and a row edited before then also gains the
client-book actions an unedited Manager already has.

Set up service and Set up the chart of accounts cover writes that a
MANAGER/ADMIN list let Managers make by API while their screens stayed on Change
settings or Manage configuration. Each route takes the new key or the screen's
key (`{ anyOf: ["service.setup", "admin.settings"] }`, for example), so whoever
can open the screen can use it. Moving the screens onto the new keys is the
owner's call.

Rules preserved from `requireAuthWithRole`, by construction rather than by
copy: `decidePermissionAccess` and `decideRoleAccess` both call the same
`resolveEffectiveRole()` and `applyBootstrapSafeguard()` in `roleDecision.ts`.

- **Resolved from the database, never the JWT.** The staff row (role, roleId,
  `isActive`) is read per request. A session's role is stale the moment someone
  is re-roled and says nothing about `isActive`.
- **No active staff row means no access** — not a default of DESIGNER.
- **Impersonation (View as)** is honoured only for a real role holding
  Impersonate (`admin.impersonate`) or Change settings (`admin.settings`):
  `IMPERSONATE` in `roleDecision.ts`, by default SUPER_ADMIN and ADMIN. It only
  ever _reduces_ privilege. Permission gates count a key only when both roles
  hold it, and role lists (`decideRoleAccess`) also require the real role to
  pass the list. An ADMIN impersonating SUPER_ADMIN is an ADMIN.
- **Bootstrap safeguard** still fires: a denied check passes while NO active,
  linked privileged staff (SUPER_ADMIN/ADMIN/MANAGER) exist, so a new
  deployment's first user is not locked out. It does NOT let them promote
  themselves from Admin > Staff: assigning a role and changing how someone signs
  in judge the caller's own active staff row (`lib/auth/roleAssignment.ts`), and
  they have none. The first admin is made on the host with `npm run
  create-admin` (`scripts/create-admin.mjs`, docs/DEPLOYMENTS.md). This line
  said "so the first user can promote themselves" until 2026-11-21, which USE-02
  had already made false.
- **Enum fallback**: `roleId = null` resolves under the enum value as a role
  key — the database grant table first, falling back to
  `permissionsForBuiltInRole()` only for a key the table does not carry. This is
  what makes the route sweep adoptable one route at a time.

The legacy role-list gates make one decision too:
`requireAuthWithRole([...])`, tRPC `roleProcedure([...])` and
`requirePage([...])` all call `resolveRoleListAccess()` in
`permissionResolver.ts`. It applies the same rules, matched against the
`StaffRole` enum. All three take `{ also }` (e.g. `WITH_COST`), answered from
the caller's Role grants beside the enum decision. Since 2026-11-21 they guard
only the two house-call routes and three pages, and no router calls
`roleProcedure`.

Until 2026-10-01 the tRPC and page gates read the staff row themselves, without
`isActive`, and turned a missing row into DESIGNER. So a deactivated MANAGER
kept the MANAGER/ADMIN reports and pages until their session expired, and any
session passed a list naming DESIGNER, such as `REPORT_ROLES`.
`roleListGates.integration.test.ts` runs every case through all three gates.

**Caching.** The grant table (every `Role` plus its `RolePermission` rows) is
cached for **30 seconds** with explicit invalidation. Every write path --
`syncBuiltInRoles()`, the Roles GUI's REST routes (`pages/api/admin/roles/`) and
`applyPreset()`, and every future one -- does two things: it bumps the `"roles"`
cache generation in the write's own transaction (`bumpCacheGenerations`,
`lib/cacheGeneration.ts`), and after commit it calls `invalidateRoleGrantCache()`.
The staff row is deliberately **not** cached; staleness there is the security bug
the catalog header describes. A change made in-process is visible immediately;
in any OTHER app process (Holt may run several, docs/HOSTING.md) within
`CACHE_GENERATION_CHECK_MS`, **2 seconds**, since each process re-reads the
generations at most that often. Only a change that bumps nothing (a psql
session) waits out the 30-second TTL. Tested across two module instances in
`multiProcessCaches.integration.test.ts`.

#### Uploaded files (SEC-04b, 2026-11-21)

Files under `data/uploads` are served by `/api/uploads/[...path]` (and `/uploads/*`
through the rewrite in `next.config.js`). Who may read each subdir is
`UPLOAD_READ_ACCESS` in `lib/secureUpload.ts`, the one home for it; read it
there rather than copying it here. The rule it follows: a subdir takes the key
`PAGE_ACCESS` (`lib/auth/pagePermissions.ts`) maps the screen that shows its files
to; a subdir no screen shows takes `admin.data`; and a subdir it does not list is
served to nobody, signed in or not. Two subdirs are public: `images/` (CMS media
and product pictures, which the storefront and emails load with no session) and
`line-drawings/` (vendor catalog art), as they were before.

Where the screen is gated on that key, granting a role the screen grants the
files: Reconcile Photos and `inventory/` both take `inventory.count`. Two screens
are not gated on their key yet. They still check a role list, and their
`PAGE_ACCESS` entry carries `widensFrom`, which means the key is not applied. The
manifest takes keys, not role lists, so their files follow the mapped key, and
the files and the screen admit different roles:

- **Ticket files** (`attachments/`, `service.read`). Only the ticket page shows
  them, and it and `GET /api/tickets/[id]` admit SUPER_ADMIN, ADMIN and MANAGER.
  Every default holder of `service.read` reads the files, so GENERAL_MANAGER,
  DISPATCH, CUSTOMER_SERVICE, DESIGNER, WAREHOUSE and INSTALLER read files on
  tickets they cannot open. A role edited to drop `service.read` whose enum role
  is still on the list keeps the page and gets 404 on its files (helpdesk.md,
  "Ticket attachments"). Before, ticket files were public.
- **Proposal pictures** (`proposals/`, `sales.read`). The proposal pages and every
  proposal API admit MANAGER and ADMIN (and SUPER_ADMIN, which passes any ADMIN
  check). Every default holder of `sales.read`
  reads the pictures, so GENERAL_MANAGER, DEPARTMENT_HEAD, DISPATCH,
  CUSTOMER_SERVICE, DESIGNER, REGISTER, WAREHOUSE and INSTALLER read pictures of
  proposals they cannot open. The names (`<proposalId>/<lineId>-<ms>.<ext>`) are
  partly guessable. Before, any session read them.

Both line up when those screens and their APIs move onto their keys, each a
`widensFrom` decision in `pagePermissions.ts`; until then, granting or removing
the key in Roles changes the files and not the screen.

The route decides the key with `resolvePermissionAccess()`, the function behind
`requirePermission`, so the staff row, deactivation, View as and the bootstrap
safeguard all apply. Every refusal is a 404, so the route never confirms a file
exists. It classifies the file a request resolves to, not its first raw segment:
Next decodes each catch-all entry after splitting on `/`, so an encoded `%2F`
could carry an absolute path to a private file inside a public-looking first
segment. `__tests__/uploadsRouteAuth.test.ts` fails when a preset, or a
hand-built path that names its subdir as a literal (joined under
`"data", "uploads"` or `UPLOAD_ROOT`, or in a stored `/uploads/<subdir>/` URL,
one self-test case per shape), writes a subdir the manifest does not list, or
the manifest lists one nothing writes (rule 65). A subdir held in a variable is
not seen. `uploadReadAccess.integration.test.ts` runs the roles against
Postgres. Customers open their ticket files through signed one-hour links
instead (helpdesk.md, "Ticket attachments").

### Not done yet (each is its own change)

- The last role lists. Of `api/service/*`, only `house-calls/index.ts` and
  `house-calls/[id].ts` are still role lists, waiting on the owner's house-call
  decision, as are the Service dispatch board and the two house-call pages. The
  rest moved to keys on 2026-11-21 (service-dispatch.md, "Who may use the
  service routes"), and so did `api/accounting/*`: the five chart routes gate
  per method, writes on `{ anyOf: ["admin.config", "accounting.chart.manage"] }`
  and reads adding `accounting.read` (the account-group reads also
  `catalog.write`), and `journal-entries/[id]` is `accounting.read` for GET and
  `accounting.post` for PUT and DELETE (accounting.md).
- Assigning roles (USE-02: `lib/auth/roleAssignment.ts`, `lib/auth/adminLockout.ts`
  and the staff page's role picker) still decides on role names. It moves to a
  key after #136.
- `roleProcedure` has no caller outside tests. `requireAuthWithRole` loses its
  last callers when the two house-call routes convert, and `requirePage`'s role
  list when the Service dispatch board and the two house-call pages do; then
  the three and `decideRoleAccess` can go. Until then tripwires hold each at what
  the sweep left: `trpcProcedureAuthorization.test.ts` fails on any mounted
  procedure built with `roleProcedure` (its gates are marked in
  `authMiddlewareMarkers.roleLists`); `apiRolePermissionRatchet.test.ts` counts
  every `requireAuthWithRole(` call in an API route, whatever its first argument
  (it once matched only a literal `[`, so a list passed as a constant escaped
  it); and `pagePermissions.test.ts` fails if a `widensFrom` page stops calling
  `requirePage` with exactly the roles its entry records.
- Dropping the `StaffRole` enum.

## Roles

Nav access is not a property of a role any more — it is what the role's grants
earn (`getVisibleNavItems`), so the column below is an OUTPUT of the grants
shipped in `BUILT_IN_ROLES`, asserted item-for-item in `navPermissions.test.ts`;
a deployment that edits those grants changes the menu, and a disabled feature
module hides its item on top.

| Role        | Nav Access (from the shipped grants)                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SUPER_ADMIN | Every item                                                                              | Owner-only tier above ADMIN. Sees `/app/admin/reports/commission-tiers` (rate schedule the owner pays per salesperson). Auto-promotes through any ADMIN gate. Holds every permission through the `"*"` wildcard.                                                                                                                                                                |
| ADMIN       | Every item                                                                              | Granted every permission in the catalog EXCEPT `OWNER_ONLY_PERMISSIONS` (`admin.impersonate`, `staff.commission-pay`) — an explicit grant list, not a bypass. Database backup, roles and query builder are ADMIN-gated.                                                                                                                                                         |
| MANAGER     | Sales, Service, Purchasing, Warehouse, Inventory, Reports, Helpdesk, Time, Admin, Tools | Hub cards show only the pages its keys open (see Card Filtering below).                                                                                                                                                                                                                                                                                                         |
| DESIGNER    | Sales, Service, Purchasing, Inventory, Reports, Helpdesk, Time, Tools                   | Lands on `/app` like everyone else; the home page shows what its keys allow (see Home page below). On the Reports hub, sees a card for each report View reports opens: Designer Dashboard, Sales by Salesperson, On hold, Referrals, Oversold, Stock and Space, Transfers, Weekly Summary, Detailed Sales Report, Tax Summary, Till Reconciliation, and both Mailchimp reports. |
| REGISTER    | Sales, Inventory, Time, Tools                                                           | POS, till, gift cards, returns                                                                                                                                                                                                                                                                                                                                                  |
| WAREHOUSE   | Sales, Service, Purchasing, Warehouse, Inventory, Helpdesk, Time, Tools                 | No Reports, no Admin. Service and Helpdesk are deliberate — WAREHOUSE holds `service.read`/`service.write`.                                                                                                                                                                                                                                                                     |
| MARKETING   | Sales, Reports, Time, Tools                                                             | Holds `customer.read` and not `sales.read`; Sales is there because Customers lives under it.                                                                                                                                                                                                                                                                                    |
| INSTALLER   | Sales, Service, Warehouse, Helpdesk, Time                                               | Used to sign in to an empty menu (no `NavPermission` default existed); its grants now produce one.                                                                                                                                                                                                                                                                              |

## Giving someone a role (USE-02, 2026-09-23)

The staff page lists every `Role` row, built-in and custom, and submits its
`roleId`. It used to hardcode six role names, so a role built on the Roles page
could never be assigned. Both paths that set a role, `PATCH /api/staff/[id]`
and `POST /api/staff`, go through one rule in `lib/auth/roleAssignment.ts`, set
by the owner:

- **Only an ADMIN or SUPER_ADMIN assigns roles.** Anyone with `staff.manage`
  (HR, a GM) may still create staff members WITHOUT a sign-in email; they get
  the default, DESIGNER, and may edit their name, store, designer flag and
  plans with the role unchanged. Anything that changes how someone signs in
  needs an admin (the third door, below). Before this, `POST` wrote whatever
  `role` it was sent, so any `staff.manage` holder could create an ADMIN. The
  `PATCH` check also refused SUPER_ADMIN.
- **Only a SUPER_ADMIN assigns the owner tier**: SUPER_ADMIN, or any role that
  grants every permission. It is the same tier impersonation already keeps an
  ADMIN out of.
- **What an assignment writes**: `roleId`, and the legacy `role` enum, which the
  two house-call routes and three pages still gate on. A built-in role writes its own key; a custom role writes
  **DESIGNER**, the least-privileged value. So a custom role never carries more
  enum-gated access than intended, and demoting an ADMIN to one really demotes
  them. The last-admin guard judges the new enum value.
- Custom-role holders get only DESIGNER on the enum-gated routes and pages that
  are left (the house-call routes, the Service dispatch board and the house-call
  pages). That is the owner's chosen trade-off.

**The same rule decides two other doors to the same power** (2026-11-20). Both
sat behind `staff.manage` alone, which People Operations and the General
Manager hold:

- **Setting a password** (`POST /api/admin/staff/[id]/set-password`). With
  local sign-in on, whoever sets a password can sign in as that person, so it
  is assigning their role: it admits an ADMIN or SUPER_ADMIN, and a member in
  the owner tier only a SUPER_ADMIN. Since 2026-11-21 it is one case of the third
  door below (`signInChangeRefusal(..., 'password')`), so it reads the member's
  tier strictly, with their row locked. Linking the member to a User that is
  already another member's login is a 409 (it was a 500).
- **Changing what a role can do** (`POST /api/admin/roles`, `PUT` and `DELETE
  /api/admin/roles/[id]`). Editing a role's grants reaches everyone who holds
  it, the editor included: `roleEditRefusalFor` admits an ADMIN or SUPER_ADMIN,
  and only a SUPER_ADMIN may grant or revoke an `OWNER_ONLY_PERMISSIONS` key,
  create a role holding one (cloning the Owner included), or delete a role that
  holds one. Keeping an owner-granted key while changing other grants is not
  moving it. The check runs inside the write's transaction, against the grants
  it re-reads there. Reading roles (`GET`) stays on `staff.manage`: the Staff
  screen's role picker needs the list.
- The Roles screen does not yet mark owner-only keys, so an ADMIN who ticks one
  sees the server's refusal, which names it.

**The third door: changing how someone signs in** (2026-11-21). A member's
sign-in email, their active status, the login their row is linked to, their
password and, for a member in the owner tier, their role each decide who can
sign in as them. Until this, `PATCH /api/staff/[id]` and `DELETE` judged none of
them beyond `staff.manage`: a General Manager could put their own address on the
Owner's row, ask for a password reset and sign in as the Owner. All of them now
go through `signInChangeRefusal` (pure core `signInRefusalFor`, in
`lib/auth/roleAssignment.ts`): **admins only, and a member in the owner tier
only by an owner.**

- **What counts as the owner tier, read strictly** (`isOwnerTierMember`): the
  enum says SUPER_ADMIN, or the Role row is the owner tier (SUPER_ADMIN or
  grants every permission), or the Role holds any `OWNER_ONLY_PERMISSIONS` key.
  Either column saying Owner is enough, because a row can be split
  (`scripts/create-admin.mjs` writes the enum only) and `callerStaffRole` reads
  the enum.
- **Sign-in email** (PATCH): compared trimmed, so a Save that resends it
  unchanged is no change and is never refused (the Staff form always sends it).
  On a change: the refusal first, then a case-insensitive collision with any
  other row is a 409 (after the 403, so a refused caller learns nothing about
  which addresses exist), open reset links are voided, and the trimmed address
  is stored. An unchanged email is left out of the write. The same refusal and
  collision check apply to `POST /api/staff` with an email, judged against the
  role the new member is being given (`subjectForAssignment`).
- **Active status**: turning someone back ON is a sign-in change and takes the
  full rule. Switching someone OFF is narrower (`deactivationRefusalFor`), since
  it lets nobody sign in as them: any `staff.manage` holder may switch off an
  ordinary member, so a departed clerk is not left active until an admin acts;
  an ADMIN or SUPER_ADMIN member needs an admin, and the owner tier (by the enum
  or the Role row, not by a held key) needs an owner. Deactivation (PATCH
  `isActive: false` or `DELETE`) also voids open reset links.
- **The login link**: the PATCH auto-link (an unlinked row gets the User whose
  email it carries) runs only when `signInChangeRefusal(..., 'login link')`
  allows it, and a staff manager's Save skips it silently. Its two guards stay:
  never repoint an existing link, never take a User that is another active
  member's login.
- **A role change on a member in the owner tier** needs an owner, so an
  Administrator cannot demote the Owner (`resolveRoleAssignment` already keeps
  anyone but an owner from assigning the tier).
- **One transaction per request.** When a request can remove someone's admin
  standing, the active ADMIN/SUPER_ADMIN rows are locked first, in id order
  (`lockActiveAdmins`), then the member's row (`SELECT ... FOR UPDATE`), and the
  row is re-read; every check and the write and the audit entry run inside it.
  A lost race (deadlock or serialization failure, `isWriteConflict` in
  `lib/errorCode.ts`) answers 409 "Someone else changed this staff member; try
  again."
- **Deliberate limits** (owner questions, strict defaults shipped): an
  Administrator may still change a PEER Administrator's sign-in; the rule judges
  the member's tier at the moment of the change, so a password an Administrator
  set while the member was ordinary still works after a later promotion into
  the owner tier; non-admin staff managers cannot fix a typo in, or replace a
  placeholder, sign-in email.
- The Staff screen matches: for a non-admin the email field is disabled ("Only
  an admin can change a sign-in email.") and its Save sends no email, and the
  on/off toggle shows only on active rows that are not ADMIN or SUPER_ADMIN.
  Every refusal the screen gets is shown as the server worded it.

Every file under `app/src` that writes a `StaffMember` or `User` row is listed,
classified and reasoned in `__tests__/fixtures/sign-in-fact-writers.txt`;
`__tests__/signInFactWriters.test.ts` fails on an unlisted writer, a stale line,
a 'guarded' file that never calls the rule, and a 'no-sign-in-fact' file that
writes email, isActive, userId or passwordHash (rule 65).

**Still open after the third door** (found in the same review, 2026-11-21; each
is its own change, highest severity first):

- _Owner-tier admin keys_ (Administrator to Owner): whether `admin.data`
  (backup and restore) and `admin.integrations` (mail and Google credentials)
  belong to the owner tier. Owner question: add both to
  `OWNER_ONLY_PERMISSIONS`?
- _Role-write sweep_ (Administrator to owner-tier keys): role writes outside
  `/api/admin/roles` and the staff routes (a role deletion's reassignment, the
  preset role apply, the staff seed route, `scripts/create-admin.mjs`) do not
  apply the owner-tier rule yet.
- _Credential carried across a promotion_ (escalation, conditional): a password
  an Administrator set on an ordinary member still works after the Owner later
  moves that member into the owner tier.
- _Session revocation_ (amplifier): JWT sessions survive a password, email or
  link change; a takeover session outlives the victim's reset.
- _PIN brute force_ (escalation): the discount-approval PIN lockout resets, so
  guessing continues fifteen minutes at a time; no per-caller limit.
- _Case-variant emails_ (denial and ambiguity): `StaffMember.email` is unique
  case-sensitively; the app-level check covers new writes only, races between
  two creates, and existing case-variant rows stay ambiguous for sign-in. A
  unique index on `lower(email)` needs a pre-check migration.
- _Body-supplied actor ids_ (low): Up-Board clock-in and clock-out take the
  staff id from the body.

**The last-admin guard counts only linked admins** (`wouldRemoveLastAdmin`,
`lib/auth/adminLockout.ts`, SEC-03). An admin row nobody has signed in as
cannot administer anything. Until 2026-11-21 it counted unlinked admin rows
while the bootstrap safeguard (`hasNoPrivilegedStaff` / `countPrivilegedStaff`)
counts only LINKED SUPER_ADMIN/ADMIN/MANAGER rows. With one unlinked admin row
present, deactivating every linked admin passed the guard and drove the
bootstrap count to zero, which reopened the bootstrap window: every gate
allowed, and any identity could sign in. Counting the same way keeps one linked
admin. The cost: an Owner cannot deactivate themselves while the only other
admin has not signed in yet.

→ `__tests__/integration/staffRoleAssignment.integration.test.ts`,
`__tests__/integration/ownerTierEscalation.integration.test.ts`,
`__tests__/integration/staffSignInIdentity.integration.test.ts`,
`__tests__/integration/staffLastOwner.integration.test.ts`,
`__tests__/roleAssignment.test.ts`

## The `isDesigner` flag — report inclusion, not auth (added 2026-05-29)

`StaffMember.isDesigner` (Boolean, default false; the migration history has since been squashed, so the column and its default now live in `0_init`) is **separate from the auth `role`**. It controls who appears on **designer-based sales + commission reports**, so a selling MANAGER can be included and a former designer excluded without changing their login role. It grants no permissions — it's a reporting dimension only.

- Toggle: `/app/admin/staff` edit form ("Show on designer-based sales & commission reports"); persisted via `PATCH /api/staff/[id]`, which is gated on `staff.manage` (its sign-in fields need an admin, see "Giving someone a role").
- Filter: `GET /api/staff?isDesigner=true` (designer pickers), `listPeriodConfirmationStatus` (pay-period grid), and the Commission Locked Payouts list (`designersOnly` where it asks).
- See `docs/domains/commission.md` "The `isDesigner` staff flag" for the full surface list.

## SUPER_ADMIN — owner-only tier (added 2026-05-19)

Sits strictly above ADMIN. Reserved for the business owner. The role exists so commission-tier data (the rate schedule the owner pays salespeople) can ship in the ERP without being visible to anyone else, including ADMIN-level staff.

Key invariants:

- **Auto-promotion over ADMIN gates** — any `["ADMIN"]` check passes for SUPER_ADMIN. The live logic is `decideRoleAccess()` in `lib/auth/roleDecision.ts`, which appends SUPER_ADMIN to any allow-list naming ADMIN. No need to spell SUPER_ADMIN out everywhere; ADMIN is implied. There is deliberately NO equivalent case on the PERMISSION path — SUPER_ADMIN holds everything through the wildcard instead.
- **PRIVILEGED_ROLES sets** — when an API needs "any privileged role," it lists `["SUPER_ADMIN", "ADMIN", "MANAGER"]` explicitly. See the one privileged-count query, `countPrivilegedStaff()` in `lib/auth/permissionResolver.ts`, feeding the bootstrap safeguard in `roleDecision.ts` for every gate.
- **Impersonation** — decided on keys (`IMPERSONATE` in `roleDecision.ts`). SUPER_ADMIN holds both through the wildcard; ADMIN holds Change settings. `pages/api/admin/impersonate.ts` gates on the same `{ anyOf: ["admin.impersonate", "admin.settings"] }`, and `impersonateGate.test.ts` pins the two equal.
- **Card filtering** — no bypass: the Owner holds every key, so sees every hub card.
- **Owner-only report** — `app/(dashboard)/app/admin/reports/commission-tiers/page.tsx` calls `requirePage(undefined, { permission: "staff.commission-pay" })`, a key in `OWNER_ONLY_PERMISSIONS`. The Reports hub's Commission card follows it.

When adding a new owner-only feature: gate it on a key in `OWNER_ONLY_PERMISSIONS`, as the commission screens do, never on a role list. Anything else takes the key of its screen ("Which key a route takes", above).

## SUPER_ADMIN vs ADMIN vs MANAGER

| Capability                                                      | SUPER_ADMIN        | ADMIN | MANAGER |
| --------------------------------------------------------------- | ------------------ | ----- | ------- |
| Admin hub (`/app/admin`)                                        | Yes                | Yes   | Yes     |
| Commission Tiers report (`/app/admin/reports/commission-tiers`) | **Yes**            | No    | No      |
| Database backup/restore                                         | Yes                | Yes   | No      |
| Roles & permissions management (`/app/admin/setup/roles`)       | Yes                | Yes   | No      |
| Query builder (`reporting.adhoc`, a store can grant it)         | Yes                | Yes   | No      |
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

A role holding Impersonate (`admin.impersonate`) or Change settings (`admin.settings`) may View as another role: by default the Owner and the Administrator. `POST /api/admin/impersonate` sets the 4-hour `holt-impersonate` cookie, or clears it. No back-office screen offers a picker: the top nav's "View as..." menu was unreachable, since no live route rendered `TopNav`, and was deleted on 2026-11-21 with `TopNav`, `AppNav`, `MainLayout`, `StandardListPage` and `CardGridPageLayout`. The amber Stop banner (`components/ImpersonationBanner.tsx`) renders only on the Pages Router `/auth/*` screens, through `_app.tsx`. The cookie is read by `requirePage`, `requireAuthWithRole`, `requirePermission`/`permissionProcedure`, `roleProcedure`, the sidebar menu (`AppSidebar`, through `useEffectiveRole`) and the hub cards (through `requirePage`).

- API endpoint: `POST /api/admin/impersonate` (sets or clears the cookie), gated on `IMPERSONATE`. It only accepts six roles — DESIGNER, REGISTER, MANAGER, WAREHOUSE, INSTALLER, MARKETING (`pages/api/admin/impersonate.ts` `VALID_ROLES`) — so ADMIN and SUPER_ADMIN cannot be impersonated at all.
- Hook: `useEffectiveRole()` in `lib/hooks/useEffectiveRole.ts` (reads cookie client-side)
- Cookie expires after 4 hours automatically
- Every gate checks that the real role, read from the database, holds a key of `IMPERSONATE` before honouring the cookie -- it cannot be spoofed by setting the cookie manually -- and `useEffectiveRole` applies the same rule to the session's keys
- Impersonation affects: nav items, card filtering, page access (server redirects), and API role checks
- Viewing as another role only ever narrows. Permission gates and keys answered beside a gate (`{ also }`, e.g. View cost) count a key only when both the real role and the viewed role hold it (`decidePermissionAccess` in `roleDecision.ts`), as the nav does on the real-role side (the nav reads the viewed role's built-in grants, not edited ones: F14a). Before 2026-10-02 gates decided on the viewed role's keys alone, so an admin whose role the owner had edited to drop a key got it back by viewing as a role that held it (F12a). Role-list gates also require the real role to pass the list (narrow-only since 2026-11-21; before, the viewed role alone decided).
- Impersonation never escalates by rank either (`resolveEffectiveRole` in `roleDecision.ts`), and the endpoint's allow-list names neither ADMIN nor SUPER_ADMIN, so there is no way to view the commission-tiers report by impersonating up
- The endpoint refuses (400, saying why) a target every gate would ignore: one ranked above the caller's own role, or any target for a role that may not View as (`viewAsIgnored` in `permissionResolver.ts`, ranked as a permission gate ranks: the linked Role, from the grant table). The client cannot rank, so before 2026-11-21 a store role holding Change settings (rank 0 by default) could set MANAGER and read "Viewing as MANAGER" over screens every gate still decided as its own role. `impersonateTarget.test.ts` pins it.
- Known gap, older than 2026-11: while viewing as a role that holds neither key, `POST /api/admin/impersonate` is refused, because `requirePermission` honours the cookie. Stopping still works, since the banner also clears the cookie in the browser, but no "Stopped viewing" audit row is written.
- The cookie value is client-set, so `grantContext` (`permissionResolver.ts`) treats it strictly as a role KEY: own-key lookups and a `Map`, never a plain-object index. Before 2026-10-15 a cookie of `constructor` or `__proto__` resolved to an `Object.prototype` member, the decision threw, and every gated request from that admin was a 500 until the cookie cleared (CodeQL #23; `permissionResolver.test.ts` "the View-as cookie is a role KEY"). Such a value now behaves as an undefined role: baseline grants only.

## Navigation

The menu is derived from permissions. Each entry in `NAV_ITEMS` (`lib/auth/navPermissions.ts`) names the permission keys that make that destination worth opening, and `getVisibleNavItems()` filters on the keys the viewer holds. Feature modules apply on top: a module switched off in `AppSettings.features` hides its item regardless of permission. Nothing bypasses the derivation, including ADMIN — SUPER_ADMIN sees every item because it holds every permission, not because of a special case.

The Admin entry carries a count of getting-started items still to do
(`lib/gettingStarted.ts`). The sidebar asks `/api/admin/getting-started`
(`admin.settings`, like its sibling `/api/admin/settings`) only when the viewer
holds `admin.settings`, and again on each navigation so the count drops as items
are finished; the Admin hub shows the full list.

The `NavPermission` table is gone — dropped by migration `20260807120000_drop_nav_permission`, along with the `/admin/setup/permissions` page and its `pages/api/admin/permissions` route. Nav is presentation, not enforcement: the viewer's permission keys ride on the NextAuth session as a display convenience, and the grant table read per request by `permissionResolver.ts` is what actually admits a request.

## tRPC procedure manifest (2026-11-18)

`__tests__/trpcProcedureAuthorization.test.ts` is the tRPC twin of
`apiRouteAuthorization.test.ts` / `apiReadRouteAuthorization.test.ts`. It walks
the real `appRouter._def.procedures` (nothing is hand-listed) and fails on any
procedure that is `publicProcedure` or session-only `protectedProcedure` unless
it is in the test's `ALLOWED` map with a written reason; it also fails on an
`ALLOWED` entry that no longer exists or is now gated.

`apiRouteAuthorization.test.ts` also reads every route whose default export
dispatches on `req.method`: each `if (req.method === "X") return ...` branch,
and, since 2026-11-21, the last statement, which runs for every method no branch
took, must return through a gate or answer 405. In `if (GET) return readGate(...);
return writeGate(...);` that line is the whole write path, and a bare handler
there passed every check (seen on `service/settings/statuses.ts`). Which gate it
takes is behavioural: `serviceRouteKeys.integration.test.ts` and
`accountingBillingGates.test.ts` refuse each such route a write by a role that
passes its read gate.

To add a procedure: use `permissionProcedure("<key>")` with the key of the screen
that calls it (that page's `requirePage(undefined, { permission })`, or a sibling
API route), not a new key. Only a truly self-scoped or public procedure goes in
`ALLOWED`, saying what makes it safe. `reports.monthlyPerformance` and `reports.salespersonDetail` moved off the
list on 2026-11-18: they are `reporting.read`, and "pick any salesperson" is the
permission `reporting.all-salespeople` (default: Manager, Administrator, Owner;
migration `20261118120000` grants it to an edited Manager/Administrator), read
through `WITH_ALL_SALESPEOPLE` like `WITH_COST`. It replaced a hardcoded
MANAGER/ADMIN/SUPER_ADMIN set; known gap as in `inventory.locations.manage`:
staff whose enum is MANAGER but whose role is another lose it.

Since 2026-11-21 every gated procedure is a `permissionProcedure`. `reports`,
`billing` and `clientPortal` were the last routers on `roleProcedure`, and their
role constants (`MANAGER_ADMIN`, `PIPELINE_ROLES`, `ADMIN_MARKETING`,
`WEALTH_ROLES`, `BILLING_ROLES`, `PORTAL_ROLES` and the rest) are gone.

## Page-Level Auth

Every App Router page calls `await requirePage()` (`lib/auth/requirePage.ts`) in its server component. Most gate on a capability via `requirePage(undefined, { permission })`: 258 of the 263 page files on 2026-11-21. Two are open to every signed-in staff member (`/app` and `/app/scan`, each with a reason in the manifest), and three pass a POSITIONAL role list, `requirePage(["MANAGER", "ADMIN", "DESIGNER"])`. Which key each page answers to is the page access manifest `PAGE_ACCESS` in `lib/auth/pagePermissions.ts`, one entry per page; `__tests__/pagePermissions.test.ts` fails on a page with no entry, or one whose entry disagrees with the guard the page calls. (This paragraph said "four pages" until 2026-10-29, long after the manifest moved most of them.) Settings → Payment Types (`admin/setup/payment-types`) answers to `admin.settings`, the key its API `/api/tenders` writes with. The purchase-order list and detail pages left their role list (MANAGER/ADMIN/WAREHOUSE) for `purchasing.read` on 2026-10-30 (GAP-01), the key their routes were already on, so a Buyer can open the POs they write. The same day, Receive moved from `purchasing.write` to `purchasing.receive`, the key its receive route uses (`docs/domains/purchasing.md`). `requirePage` resolves through the same `decideRoleAccess`/`resolvePermissionAccess` helpers as the API guards. The bootstrap safeguard skips role enforcement until at least one active signed-in privileged user (SUPER_ADMIN/ADMIN/MANAGER) exists.

The 2026-11 role-list sweep moved 57 pages off their role lists, each onto the
key of the data routes it loads, so a page opens exactly when its data does. The
warehouse and dispatch pages left their MANAGER/ADMIN/WAREHOUSE list for their
data routes' keys: dispatch on `warehouse.operate`; the warehouse dashboards,
positions, locations and transfers on `inventory.transfer`; Inbound on
`purchasing.receive`; Pickups and Returns on `sales.return` (inventory.md,
service-dispatch.md). Needs Ordering, Receiving Records, Import Order and Import
Apparel PO are on `purchasing.receive`; the consignment Credits Owed, PO
Management and Receiving Gaps pages on `accounting.read`; Freeze on
`inventory.count`; a helpdesk ticket on `service.read`; the reports that were
role lists on `reporting.management`, `reporting.financial`, `marketing.lists`
or `customer.wealth` (reporting.md); the Invoices pages on `accounting.invoice`;
and the B2B proposal pages on `sales.proposal`. Three keep a role list, with
`widensFrom` in `PAGE_ACCESS`, because their mapped keys would widen access the
owner has not confirmed: the Service dispatch board and the two house-call
pages.

The only Pages Router `.tsx` files left are `_app`, `_document` and the three `/auth/*` screens. Their scripts run only because `pages/_document.tsx` passes the request's nonce to `<Head>` and `<NextScript>`: every page carries a nonce Content-Security-Policy (`src/proxy.ts`, `docs/DECISIONS.md` entry 62), Next stamps the Pages Router's scripts from those props alone, and without them every script on the sign-in screens is blocked and nobody can sign in. The browser page sweep opens the three screens signed out (`e2e/pages.spec.ts`).

## Who the caller is (2026-11-21)

A route that needs the caller's own staff row (to record who opened a till, to
show "my" pipeline, to set "my" active store) gets it from
`sessionStaffMember(session, select, db?)` in `lib/auth/roleAssignment.ts`: the
**active** row whose `userId` is the session's User id, or null when the session
carries no id or no active row is linked to it. That is how every gate resolves
the caller (`permissionResolver.ts`), so a route can no longer act as a
different row than the one its gate admitted. `callerStaffRole` is the same
lookup, selecting `role`. Pass a transaction as `db` when the lookup belongs in
one (`create-from-cart`, `duplicate`, opening a service case, the till routes'
injected client).

**Never by email.** Until 2026-11-21 thirteen routes found the caller with
`staffMember.findFirst/findUnique({ where: { email: <session email> } })`, with
no `userId` and no `isActive` filter: `interactions/active.ts`,
`sales/interactions/index.ts`, `sales/clients/index.ts`,
`sales/pipeline/index.ts`, `sales/pipeline/[id].ts`,
`sales/orders/create-from-cart.ts`, `sales/orders/[id]/duplicate.ts`,
`registers/[id]/tills/open.ts`, `tills/[id]/close.ts`, `service/dashboard.ts`,
`service/cases/index.ts`, `service/cases/[id]/notes.ts` and
`staff/active-store.ts`. Anyone holding `staff.manage` can write a staff
member's email (People Operations, the General Manager), so they chose whose row
those routes acted as: a General Manager who gave the Owner's row their own
session email opened tills as the Owner, saw the Owner's pipeline and archived
quotes under the Owner's scope, and moved the Owner's active store. A deactivated
row was matched too. And where the session had no email, five lookups (both till
routes, open and close, and the service-note, service-case and service-dashboard
lookups) passed `email: undefined`, which Prisma drops from the filter, so they
matched whichever staff row came first. The warehouse transfer request found its
requester the same way on `User` (`user.findUnique` by the session email); it now
takes the session's User id.

The session's email is still written where it is only a label (`createdBy`,
`updatedBy`, the order's `salesperson` fallback, the duplicated quote's actor
email); a label decides nothing.

Only four lookups in three files may still find a staff member by email,
because there is no session yet: in `authProviders.ts`, local sign-in checking
the typed email (`authorizeLocal`) and the OAuth sign-in allowlist admitting a
provider-verified email only if an active staff row holds it
(`findActiveStaffByEmail`); a password-reset request (`passwordReset.ts`); and
first sign-in linking an unlinked row to the User the identity provider verified
(`[...nextauth].ts`). Two more look up by email without deciding who the caller
is: the staff routes' collision check, whether an address being written is already
another row's (`staff/[id].ts` and `staff/index.ts`, case-insensitively).
`__tests__/staffEmailLookupRatchet.test.ts` fails on any
other `staffMember` call whose `where` names `email`, and on a listed exception
that has gone. It cannot see a `where` built in a variable and passed by name
(three such sites exist, none keyed by email), a `user` lookup, or a screen: the
Service screen's "My Cases" tab and the Interactions screen still pick the
caller out of the staff list by email in the browser (tracked).
Behaviour: `__tests__/integration/sessionStaffIdentity.integration.test.ts`
gives the Owner's row the General Manager's session email (and the GM's row
another address), and asserts the pipeline, opening a till and setting the
active store act as the General Manager; and that a warehouse transfer records
the session's own User when its email belongs to another User row.

## A session whose user is gone (2026-10-17)

A session is a signed JWT carrying a user id, and it outlives the `User` row it
was minted for. A demo re-seed truncates `User`; an operator can delete one.
Until 2026-10-17 such a session still verified, every guard answered 403, and
every page rendered its shell: no menu, an empty dashboard, nothing saying why.

Now every gate treats it as no session (`lib/auth/sessionEnded.ts`
`sessionAccountEnded`): `requirePage` redirects to `/auth/login`;
`requirePermission` and `requireAuthWithRole` answer **401** "Your session has
ended. Sign in again."; `permissionProcedure` and `roleProcedure` throw
`UNAUTHORIZED`. The API and tRPC gates only look when the resolver has already
refused for `noActiveStaff`, so an admitted request pays nothing.

Deliberately still 403, not signed out: a user row with no staff record (the
bootstrap safeguard's first operator) and a deactivated staff member -- treating
deactivation as signed out would loop in the bootstrap window, where the API
still admits them. Tested in `__tests__/integration/sessionEnded.integration.test.ts`.

## Automatic sign-out (GAP-27, 2026-10-31)

A signed-in session ends after the store's idle time: Settings → Automatic
sign-out, `AppSettings.idleLogoffMinutes`. It is 5 to 720 minutes, or 0 for
never. The default is 15, the strict one (owner, 2026-10-31: "This should be
some sort of config"). The rules live in `lib/auth/idleLogoff.ts`.

**What counts as activity.** Only a person at the screen counts: typing,
tapping, the mouse, scrolling. A screen refreshing itself does not, so neither
the home dashboard nor the Up Board keeps a session alive by refreshing itself.

**The browser** (`components/auth/IdleLogoff.tsx`, mounted once in
`AppShell`, so on every back-office screen):

- notes activity in every tab of the browser through `localStorage`;
- reports it to the server at most once a minute, via next-auth's session
  `update({ active: true })`. Loading a page counts and reports at once;
- a minute before the time runs out, shows "Still there?" with a countdown;
- then signs out to `/auth/login?reason=idle&callbackUrl=<the screen>`. The
  login page says why, and after sign-in returns to that screen;
- if the session ends elsewhere (another tab signed out), goes to the sign-in
  screen instead of going on showing the page.

**The server** (`lib/auth/sessionToken.ts`):

- The JWT's `exp` is set from the token's `lastActiveAt`, not from now:
  `lastActiveAt + idle time + 2 minutes of grace`, by a custom `jwt.encode` in
  `[...nextauth].ts`.
- Every reader already refuses a token past `exp`: `getServerSession` behind
  the API gates and the routes that call it themselves, and `getToken` behind
  `requirePage` and the tRPC context. So the idle time is enforced at every
  gate without a check in any of them, including gates added later.
- An idle session reads as no session: 401 from an API route, a redirect to
  sign in from a page, no user in tRPC.
- `lastActiveAt` moves only at sign-in and on the browser's report
  (`stampActivity`, `trigger === "update"` with `active: true`), and the time
  stamped is the server's. A background request re-issues the token with its
  `exp` unchanged: `sessionMaxAgeSeconds` counts whole seconds on each side, so
  `exp` is the second the end falls in whenever the token is issued. Until
  2026-11-27 it rounded the time left instead, and `exp` moved a second back
  and forth between re-issues (harmless, but it failed
  `idleLogoff.integration.test.ts` now and then).
- Once the time has run out, a re-issued token is born already expired.
- The grace is longer than the reporting interval, so the server never ends a
  session before the browser's warning has finished. It also ends one the
  browser can't (a closed laptop, a killed tab).
- A session issued before this change gets one idle time from its next
  request.

**Signing out sticks** (`lib/auth/endSession.ts`, every sign-out in the app):

- **The race.** `signOut()` clears the session cookie, but every API response
  re-issues it, so a poll sent just before a sign-out can answer just after and
  put the session back. GAP-27's browser check found this on 2026-10-31: the
  idle sign-out landed on the sign-in screen with the session still live. The
  Sign out buttons had the same race, and on a session with no idle time a
  session put back that way lasted 30 days.
- **The fix.** `signOutTo` marks the tab in `sessionStorage`, signs out, and
  goes to the sign-in screen. Once that screen has replaced the old one (whose
  requests have answered or been abandoned), `confirmSignedOut` signs out any
  session that came back. It looks again, up to three times, because its own
  first session read can race too.
- **Why a mark.** Only a sign-out sets it, so a link to `/auth/login` can't
  sign anyone out. Next-auth's CSRF check on sign-out exists to stop exactly
  that.
- **The tripwire.** `__tests__/lib/auth/endSession.test.ts` fails if any file
  but the helper calls next-auth's `signOut`.

**A change in Settings** takes effect on the server at a session's next
request (settings are cached for up to a minute). The browser picks it up at its
next session read, which happens on its next activity report or when the window
regains focus. With the setting at 0, a session lasts the 30-day ceiling
(`session.maxAge`), as before GAP-27.

**Consequence.** A screen left open as a display, such as the Up Board on a
sales-floor tablet, is signed out like any other. A store that keeps one sets a
longer time, or turns sign-out off.

Tested in `__tests__/integration/idleLogoff.integration.test.ts` (real
next-auth readers and encoder, the real session route with its CSRF check, a
real database), `__tests__/lib/auth/idleLogoff.test.ts` and
`__tests__/lib/auth/endSession.test.ts`.

## Card Filtering

A hub page filters its cards on the server (2026-11-21). `lib/auth/hubCards.ts`
takes each card's destination page key from `PAGE_ACCESS`, the manifest that
`pagePermissions.test.ts` binds to each page's `requirePage` literal. Where a
page opens wider than its data, the card also needs the key in
`CARD_KEY_OVERRIDES`: Pipeline `sales.lead`, Interactions `customer.write`,
Sales Returns `sales.return`, Import HD Proposal `admin.data`, Till
`pos.till.manage`, Mailchimp Activity Log `customer.read`. House Calls shows on
`admin.settings` while its page waits on the owner. The hub asks for those keys
through `requirePage(..., { also: hubCardKeys(ITEMS) })`, View as applied, and
passes `CardGrid` only the held cards (`visibleHubCards`). `CardGrid` applies
only feature modules. A card to a page the manifest does not list, or to a
pending page with no override, never shows. `__tests__/hubCards.test.ts` is the
tripwire and runs every hub; it also fails on an override without a reason, one
no card links to, or one equal to its page's key. Delete an override once its
page and its data settle on one key.

Before, each card carried a `roles` array and SUPER_ADMIN saw every card. No
built-in role lost a card to a page it can open. The Warehouse hub's Overview,
Receiving, Transfers and Returns Queue cards now show to MANAGER and
GENERAL_MANAGER, who were hidden from them; the Reports hub shows every report
reader the reports their keys open; and cards to pages that would redirect the
viewer (Inventory's Create New Product, Mass Price Change and Sales for
Designer, Register and Warehouse, for example) no longer show.

## Cost Visibility ("View cost")

What the store pays is behind one key, `catalog.cost` ("View cost"), owner
decision Q3 (2026-09-24, SEC-14). It is never a gate. A screen that shows cost
next to other figures still opens for everyone its own key admits, and the
server leaves the cost out for a caller without View cost. That's because
locking someone out of a working screen is worse than the leak it would
prevent.

**Covered so far:**

- inventory valued at cost: the Inventory hub's on-hand totals (by department,
  by location) and Summary Details;
- purchase-order cost: the purchase order list's totals, the detail page's
  unit costs, line totals and receipt costs, the receiving records' cost, and
  the inbound dashboard's totals;
- reports on "View reports": Open Orders' PO values; Sales by Salesperson's
  cost, margin and margin %, in the summary, the drill-down and the CSV
  export; and the Designer Dashboard's average margin. Their tRPC procedures
  are gated on "View reports", the pages' key, through
  `permissionProcedure("reporting.read", WITH_COST)`. Open Orders answers the
  key in `requirePage(..., WITH_COST)`;
- consignment rug cost: the consignment list and item page, the count and
  return scanners, receiving gaps and the returns history. Tag prices (anchor,
  retail) stay for everyone. The item page's edit drops cost from a caller
  without the key (`dropCostWrites`), so a screen that never received cost
  cannot save it back as empty or zero;
- consignor payouts: payment batches (list and detail), PO Management's sold
  rugs and credits, unpaid sales, credits owed, and the Consignment Summary
  report's values (`consignmentSummaryForCaller`, applied in the server page).
  A caller without the key can still create a batch and apply credits: the
  server totals stored cost, and the response carries counts only;
- management reports on View management reports (`reporting.management`, a
  MANAGER/ADMIN role list until 2026-11-21): Gross Margin's cost, margin and
  margin % (rows ordered by revenue without the key, since margin order would
  give the ranking away), Top & Bottom Sellers' margin columns (a margin ranking
  is answered by revenue, and the response's `metric` says so) and Sales
  Explorer's cost and margin at every level, through
  `permissionProcedure("reporting.management", WITH_COST)`;
- stock and buying reports: Inventory Health's cost value, dead-stock cost,
  dead % and uncosted units (rows ordered by retail value without the key);
  PO Sell-Through's margin per frame and overall (frames keep only
  `FRAME_PUBLIC_FIELDS`, an allow-list in `lib/buyPerformance.ts`, plus the
  realized retail ratio, so a cost field added later stays out until someone
  classifies it); the Buyers
  Report's sold cost and margin, on screen and in its CSV (its dead-money list
  is ordered by units on hand without the key), through
  `permissionProcedure("reporting.management", WITH_COST)`; and Open PO Gaps'
  PO cost (`poGapsForCaller` in the server page, which asks View financial
  reports with `WITH_COST`).

Other screens still show cost under their own key and move under this switch
one change at a time: products, proposals, purchase-order imports, the vendor order tools and the buyer
workbench. The query builder moved under it with `reporting.adhoc` (DECISIONS 53). The key's description
in `permissionCatalog.ts` names exactly what it covers, so the Roles screen
never claims more than it does. Keep the two in step.

**Exempt by design:** Destructive data operations (`admin.data`: backups, full
data exports and the import tools, such as the consignment rebuild's
outstanding total) can already copy the whole database, so they include cost.
Journal entries keep cost of goods sold under View accounting, and an uploaded
file still shows its own costs in the import preview.

**How a route opts in.** It passes `WITH_COST` (`lib/auth/costVisibility.ts`)
to its gate. `requirePermission` and `requireAuthWithRole` take
`{ also: [...] }` and answer those keys from the same staff read as the gate,
as `access.holds`, the handler's fourth argument. The route then asks
`canViewCost(access)`, or uses `rowsWithCostFor(access, rows, fields)`. The
response carries `costVisible`, and the screen hides its cost columns from that
answer, never showing $0. Where cost would be, it shows `CostHiddenNote`.
tRPC's `permissionProcedure` and `roleProcedure` take the same option and put
the answers on `ctx.holds`; `requirePage` returns them as `holds`.

- `canViewCost` throws if the gate didn't ask, so a route can't silently strip
  cost from holders.
- An unknown key in `also` fails when the route loads.
- Extra keys never consult the bootstrap safeguard: a request the safeguard
  admitted holds every key, and any other request holds a key only by grant.
- Viewing as another role only narrows the answers: a key is held when both
  the viewer's own role and the viewed role hold it, as the nav already decides
  (`resolveViewerPermissions`, `navPermissions.ts`). An administrator whose
  role lost View cost does not get it back by viewing as a MANAGER.

**Defaults.** On for the 12 built-in roles that see cost on some screen today,
which is every role except DISPATCH, CUSTOMER_SERVICE and INSTALLER. Nothing
changes until the owner unticks it. Migration `20261001120000_grant_catalog_cost`
grants it to edited and custom roles by the same rule, once, for every screen it
will cover, so every role that exists when it runs keeps all the cost it sees.
A role created or edited later has whatever its View cost box says, and each
change that moves another screen under the key says so in its release notes.
`permissionCatalog.test.ts` holds the rule and the lists equal.

Wealth data, below, is the same kind of decision, and became a key the same
way on 2026-11-21: See wealth data (`customer.wealth`).

## Wealth Data Visibility

Wealth data (net worth, tier, signals) is **See wealth data** (`customer.wealth`,
sensitive): the Owner, Administrators and Marketing by default. MANAGER does NOT
hold it by default. Until 2026-11-21 it was decided by role name: ADMIN/MARKETING
lists on the server, and ADMIN/SUPER_ADMIN checks in the customer page, the
Pipeline and the Leads board.

Enforcement is at BOTH layers (a page-level check alone is insufficient — the
data would still leak via network inspector):

1. **A page whose whole content is wealth requires the key**: Wealth Insights,
   page and `reports.wealthInsights` alike.
2. **A route that serves wealth beside other data asks the key in its gate's
   `also`** (`WITH_WEALTH` / `VIEW_WEALTH`) and leaves wealth out via
   `canViewWealth(access)` (`lib/auth/wealthVisibility.ts`, which throws when the
   gate did not ask). It says `wealthVisible` in the response, and the screen
   shows wealth only from that: `api/customers/[id]` GET, `api/sales/pipeline`,
   `api/leads`. The Opportunities lists (`reports.opportunityTiles` and
   `opportunityDrill`, on See customer lists) ask `WITH_WEALTH` too: without the
   key the wealth-based tiles are left out of the counts and answer NOT_FOUND as
   lists, and no row carries `wealthTier`.

The lead score tier (HOT/WARM/COOL/NEW) stays visible to everyone — safe because
it reveals no wealth details even when wealth data contributed to the score. See
`lib/leadScore.ts`. The exact score is View marketing (`marketing.read`); the
customer GET and the leads API say `scoreVisible`.

## Home page (no role redirect)

Every staff member lands on `/app` (owner decision Q5, 2026-09-24; F1). Until then, `app/(dashboard)/app/page.tsx` redirected the DESIGNER enum to `/app/sales`, which also sent every custom role there, because a custom role carries the enum DESIGNER. What the page shows follows keys, decided in `lib/homeSections.ts`:

- **Store cards:** need the Store Traffic module on, plus "View store traffic" (`reporting.traffic`) or "View orders" (`sales.read`). Each card shows only the half its key allows, so a viewer without `sales.read` no longer sees "$0 Net Sales". The cards are titled "Store Sales" when only the sales half shows.
- **Designer Rotation (Up Board):** needs its module (`staff.self`, so everyone). Its Sign In panel reads `/api/upboard/roster` (id, name and role of active staff, on `staff.self` like `clock-in` itself), not `/api/staff`, which is "Manage staff".
- **A notice** says whether an empty page means the modules are off or that nothing on it is part of this role.

`uiRoleNameBranches.test.ts` scans every file under `src/app` and `src/components`. Any role-name branch outside its declared, reasoned debt list fails CI. Since 2026-11-21 the list holds the staff page's role picker (USE-02) and the staff pickers that filter on the role enum, which should move to the `isDesigner` flag; hub cards, the order, till and lead buttons, and the wealth columns left it for keys.

## Up-Board

Staff rotation board for customer assignment. Managed in `lib/upboard.ts`. Shifts auto-expire after 9 hours. `compactAndPromote()` removes gaps. Each store location has its own independent board.

## Key Files

- `lib/auth/permissionCatalog.ts` -- the permission vocabulary + built-in roles
- `lib/auth/permissionResolver.ts` -- the one "may this user do X" resolver, grant-table cache
- `lib/auth/builtInRoles.ts` -- idempotent built-in role seed + orphan-key check
- `lib/auth/roleDecision.ts` -- pure decisions; impersonation + bootstrap rules
- `lib/auth/navPermissions.ts` -- the nav vocabulary; menu derived from permissions
- `lib/auth/pagePermissions.ts` -- `PAGE_ACCESS`, the page access manifest: each page's key
- `lib/auth/hubCards.ts` -- which hub cards a viewer sees (the destination page's key, plus `CARD_KEY_OVERRIDES`)
- `lib/auth/wealthVisibility.ts` -- See wealth data, answered beside a gate like View cost (`WITH_WEALTH`, `canViewWealth`)
- `lib/auth/requireAuth.ts` -- API auth wrappers (`requireAuthWithRole`, `requirePermission`)
- `lib/auth/requirePage.ts` -- App Router page gate (positional role list, or a capability)
- `lib/auth/idleLogoff.ts` -- automatic sign-out's rules (what a store may set, warning, expiry)
- `lib/auth/sessionToken.ts` -- the session JWT's encoder: expiry from the last activity
- `components/auth/IdleLogoff.tsx` -- the browser's idle timer, warning and sign-out
- `lib/auth/endSession.ts` -- every sign-out, and the sign-in screen's check that it held
- `lib/auth/freshOAuthSignIn.ts` -- an OAuth sign-in never sees the session cookie, so it can't link onto whoever is signed in
- `lib/auth/signInAccounts.ts` -- the NextAuth adapter: `linkAccount` refused onto an existing staff member's User, and recorded
- `lib/auth/roleAssignment.ts` -- who may assign a role, set a password or edit a role; `sessionStaffMember`, the one way a route finds the caller's own staff row (see "Who the caller is")
- `lib/auth/roleAdmin.ts` -- wire types + serialization shared by the Roles GUI and its API
- `lib/auth/secretsEqual.ts` -- the one constant-time comparison for a secret a request presents (`timingSafeEqual` always over the expected secret's length, then the lengths must match; no hashing, which CodeQL read as a weak password hash; an empty expected secret never matches). Used by the scheduler's service key (`lib/automations/guardAutomation.ts`) and the bookings feed token (`pages/api/bookings/feed.ics.ts`); `automationKeyTripwire.test.ts` fails on a `Bearer` header compared with `===` or `!==`
- `server/trpc/trpc.ts` -- `roleProcedure` / `permissionProcedure`
- `__tests__/trpcProcedureAuthorization.test.ts` -- the tRPC manifest (see "tRPC procedure manifest")
- `lib/hooks/useEffectiveRole.ts` -- client-side hook for impersonation-aware role; who may View as is `mayImpersonate` over the session's keys
- `pages/api/admin/impersonate.ts` -- set/clear impersonation cookie, gated on `IMPERSONATE`; refuses a target the gates would ignore (`viewAsIgnored`)
- `pages/api/admin/roles/` -- Roles GUI's REST contract, gated on `staff.manage`; its writes also take `roleEditRefusalFor` (admins only; owner-only keys by an owner)
- `lib/upboard.ts` -- up-board rotation logic
- `app/(dashboard)/app/admin/setup/roles/` -- build and edit roles (page gate: Manage configuration, `admin.config`)

## Verification Checklist

- [ ] `npm test -- navPermissions` passes
- [ ] Every page calls `requirePage()` (or explains why not)
- [ ] New pages pass a `permission` and get a `PAGE_ACCESS` entry, never a role list
- [ ] A new hub card links to a page with a `PAGE_ACCESS` key (`hubCards.test.ts`); cards carry no roles
- [ ] A new nav destination has an entry in `NAV_ITEMS` naming a real permission
- [ ] `/app` shows each section only to the keys that allow it (`homeSections.test.ts`), and no UI file outside the declared debt branches on a role name (`uiRoleNameBranches.test.ts`)

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

Kept for the reasoning, not as a description of the live path.
`lib/auth/withAuth.ts` was deleted on 2026-10-01: nothing had imported it since
pages moved to `requirePage`, and it held a weaker copy of the rules (the role
from the JWT, a bootstrap count that failed open). The rules below now live in
`lib/auth/roleDecision.ts` and `resolveRoleListAccess()`, which every router
shares.

`lib/auth/withAuth.ts` was previously a single 60-line function with cognitive complexity 18. Refactored into three pure helpers:

- `resolveEffectiveRole(session, ctx)` — real role + impersonation cookie → effective role for the check
- `isAuthorized(userRole, allowedRoles)` — direct match OR SUPER_ADMIN-over-ADMIN auto-promotion
- `hasAnyPrivilegedUser()` — bootstrap-safeguard DB count; fails open (allows access) on DB error

Behavior was identical to the prior monolith. If you're working on auth-related code, call the `roleDecision.ts` helpers — not these.

---

Last verified: 2026-11-21 (the status table, Adding a key, Not done yet, Impersonation, Card Filtering, Cost Visibility, Wealth Data Visibility, Page-Level Auth and the tRPC note); 2026-10-01 for the role-list gates; the rest as of 2026-05-20

## Sign-in redirect (`?callbackUrl=`)

`/auth/login` reads `callbackUrl` from the address bar, so anyone can craft a
login link carrying one. It passes through `safeCallbackUrl`
(`lib/auth/safeCallbackUrl.ts`) before it reaches `signIn()` or
`router.push()`: resolved against the page's own origin, kept only if it is
still that origin, and rebuilt as `origin + path`. Anything else lands on
`/app`. Before 2026-10-15 it was used raw, which made the login page an open
redirect and, for a `javascript:` value, a script sink (CodeQL #6, #9;
`__tests__/safeCallbackUrl.test.ts`). NextAuth's own `redirect` callback is the
default (same-origin only), which covers the server side.

## OAuth sign-in is always a fresh sign-in (2026-11-21)

Source read for this section, 2026-11-21: `pages/api/auth/[...nextauth].ts`,
`lib/auth/freshOAuthSignIn.ts`, `lib/auth/signInAccounts.ts`,
`lib/auth/authProviders.ts`, and in the installed next-auth 4.24.15
`core/lib/callback-handler.js`, `core/routes/callback.js`,
`core/lib/cookie.js` (SessionStore) and `next/index.js`.

**The hole.** On an OAuth callback NextAuth decodes the session cookie and takes
the signed-in user from it. When the incoming Google/Okta/Azure account is linked
to nobody, it calls the adapter's `linkAccount` onto _that_ user. The `signIn`
callback sees only the incoming identity and admits it when its email belongs to
any active staff member (`findActiveStaffByEmail`). So any active staff member at
a browser where the Owner or an Administrator was signed in could finish consent
with their own account and leave an `Account` row pointing at the Owner's User;
every later sign-in with that account was the Owner. A password reset did not
undo it, and nothing in Holt lists or removes `Account` rows.

**Layer 1, the request (`lib/auth/freshOAuthSignIn.ts`).** The `[...nextauth]`
handler hides the session cookie (every cookie whose name starts with
`next-auth.session-token`, either prefix, by the rule NextAuth itself reads the
session with: its numbered pieces and any variant name) from NextAuth on
`signin/<provider>` and `callback/<provider>` for
every provider except `credentials`, so NextAuth takes its not-signed-in branch:
the sign-in is as whoever the OAuth identity belongs to. On the callback the old
cookie is also expired in the reply, ahead of the new one NextAuth appends, since
NextAuth can only clean up the pieces it saw. Other cookies (state, PKCE, CSRF,
callback URL) are untouched.

- Hiding, not refusing, keeps a shared register working: the next person signs in
  with their own Google account and the register becomes theirs, with no
  sign-out first.
- A callback that ends in a refusal or a cancelled consent leaves that browser
  signed out, not still signed in as the person before.
- The password callback is left alone: it never reads the session
  (`core/routes/callback.js`), and a mistyped password should not sign out
  whoever is at the register. An unknown provider id gets the fresh sign-in.

**Layer 2, the write (`lib/auth/signInAccounts.ts`).** `authOptions.adapter` is
`PrismaAdapter` with `linkAccount` refused onto any User a staff member already
signs in as (`StaffMember.userId`). A first sign-in still links: NextAuth creates
the User and links it in the same callback, before the jwt callback joins a staff
member to it, so that User has no staff member yet. NextAuth renames any error an
adapter method throws (`core/errors.js`, `adapterErrorHandler`), so a refusal
reaches the browser as NextAuth's generic `error=Callback`; it is logged and
recorded as `SIGN_IN_LINK_REFUSED`, which is where it says what happened.

**Recorded.** `events.linkAccount` writes `SIGN_IN_LINKED` (actor: the incoming
identity's email; details: provider, provider account id, User id). NextAuth 4
never calls `unlinkAccount`, and nothing in Holt does.

**What this does not change.** A staff member whose User row already exists (for
example one an admin gave a password, `admin/staff/[id]/set-password.ts` creates
the User) and who has no `Account` cannot start signing in with Google: NextAuth
finds the User by email and, with `allowDangerousEmailAccountLinking` off, refuses
with `OAuthAccountNotLinked`. That was already true signed out; signing in with a
password first and then with Google used to link Google onto that person, and now
does not. Joining a second sign-in to someone needs a deliberate admin flow, which
does not exist yet.

Real-DB proof: `__tests__/integration/oauthLinkNeedsFreshSignIn.integration.test.ts`
drives the real `[...nextauth]` handler, NextAuth core and Prisma adapter; only the
identity provider's token and userinfo answers are local. The request rewrite's
cases are in `__tests__/freshOAuthSignIn.test.ts`.

## Password reset + my-account (2026-06-10)

Self-service for the local (credentials) sign-in method — every surface 404s
when `AUTH_LOCAL_ENABLED` is off:

- **Forgot password**: `/auth/forgot-password` (link on the login form) →
  `POST /api/auth/forgot-password` (rate-limited 5/15min). ALWAYS answers
  `{ ok: true }` — no account enumeration; the reset email only goes out for
  an active staff email. Token model `PasswordResetToken` (migration
  `20260610c`): the token table holds only the SHA-256 of the raw token, 1-hour
  expiry, single-use, and a new request voids prior open tokens. **The raw link
  is still stored**: the reset email goes through the durable queue, and
  `EmailQueue.html` (`lib/email/queue.ts`) keeps the rendered email, link
  included, after it is sent, so anyone who can read that table or a backup of
  it can use an unexpired link. This said "only the SHA-256 of the raw token is
  stored" until 2026-11-21. Tracked, not fixed: keep the reset email's html out
  of the queue, or redact the link after send, with the owner-tier admin keys
  unit (backups expose the table).
- **Open links die with the identity they were sent to** (2026-11-21): an email
  change or a deactivation through the Staff routes voids the member's open
  tokens; the request locks the member's row and re-checks the email and
  active status before making a token, so it cannot outrun those writes; and a
  reset is refused for a member who is no longer active, however they were
  switched off.
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

**Register PIN (GAP-06, 2026-10-30).** My Account also sets the PIN a manager
approves a discount with, through tRPC `account.setPin`. It shows whether or not
local passwords are enabled, but proves the current password when the account
has one. `StaffMember.pinHash` holds a scrypt hash in the password's format
(`hashPin` in `lib/auth/password.ts`, checked with `verifyPassword`). A PIN is
4 to 8 digits, so its strength is the lockout:

- five wrong tries set `pinLockedUntil` fifteen minutes out;
- setting the PIN again clears the count and the lock.

The rules for who may discount, and who may approve, are in pos.md, "Discounts
and manager approval".

**Credentials never leave the server (2026-11-14).** `passwordHash` and
`pinHash` (and the PIN lockout columns) are read only by the code that signs in,
sets or resets a password or PIN, and checks a manager's PIN. Everything that answers with a staff row names its columns,
an allowlist, never a strip-list:

- the staff screens' routes (`/api/staff`, `/api/staff/[id]`) select
  `STAFF_RECORD_SELECT` (`lib/staffRecord.ts`). They used an `include`, which
  returns every column, so both hashes reached the browser of whoever manages
  staff;
- an installer's linked staff member and a delivery run's driver are sent as
  `{ id, displayName }` (they were `staffMember: true` / `driver: true`);
- the data export (Admin › Export Data) selects each entity's `columns` from
  `lib/genericExport.ts`. It used to read every column and strip a short list of
  secret names, and `pinHash` was not on it, so the Staff CSV carried it.
  `__tests__/genericExportColumns.test.ts` holds every exported model's columns
  to the schema: each is exported or excluded with a reason, and no exported
  column may carry a credential-shaped name.

Real-DB proof: `__tests__/integration/staffCredentialsStayHome.integration.test.ts`
and `__tests__/integration/genericExport.integration.test.ts`.
