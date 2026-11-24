-- Keys for the role lists retired in the role-list sweep, 2026-11-21.
--
-- Pages, routes and tRPC procedures that decided access with a hardcoded list
-- of staff ENUM roles (requireAuthWithRole, roleProcedure, requirePage's role
-- list, `role === "X"`), which a store could not change, now ask for permission
-- keys, set per role in Roles. Most moved onto keys that already existed. These
-- eleven are new, and each starts on for exactly the roles its lists let
-- through (a list naming ADMIN also let SUPER_ADMIN through). Who held each
-- before:
--
--   sales.proposal           MANAGER, ADMIN: the B2B proposal pages and the
--                            eight /api/proposals routes.
--   customer.trade           MANAGER, ADMIN: /api/customers/[id]/trade (trade
--                            account, trade tier and tax exemption).
--   customer.address         DESIGNER, MANAGER, ADMIN, WAREHOUSE, MARKETING:
--                            /api/customers/[id]/addresses. Custom roles passed
--                            it too, because their staff carry the enum DESIGNER.
--   customer.wealth          ADMIN, MARKETING: the server's wealth checks behind
--                            Wealth Insights, Opportunities, the customer record,
--                            the Pipeline and the Leads board.
--   payment.return-refund    SUPER_ADMIN, MANAGER, ADMIN, REGISTER, WAREHOUSE:
--                            /api/returns/[id]/refund, which now also accepts
--                            "Refund payment" (payment.refund).
--   accounting.invoice       SUPER_ADMIN, ADMIN, MANAGER: the billing router, the
--                            client-hub link and the four Invoices pages.
--   accounting.chart.manage  MANAGER, ADMIN: the five chart-of-accounts routes.
--                            The screen stays on "Manage configuration".
--   service.setup            MANAGER, ADMIN: the delivery-zone, installer,
--                            case-setting and email-template routes. The screens
--                            stay on "Change settings" or "Manage configuration".
--   reporting.management     MANAGER, ADMIN: 17 management report pages and their
--                            procedures in the reports router.
--   reporting.financial      ADMIN only: Balance Due Aging, Stale Quote Cleanup,
--                            Consignment Summary and Open PO Gaps.
--   marketing.lists          ADMIN, MARKETING: the Customer Report and
--                            Opportunities, and choosing any salesperson on
--                            Sales by Salesperson.
--
-- One existing key gains a role: MANAGER gets "Post journals" (accounting.post).
-- Managers posted, marked exported and deleted the daily journal through the
-- MANAGER/ADMIN list on journal-entries/[id], and that is now this key.
--
-- One existing key reaches edited rows it never reached: "Manage client books"
-- (sales.clients.manage), for MANAGER and ADMIN. The Pipeline's all-staff
-- view, one salesperson's board, search across every open quote, and archiving
-- or bulk-archiving anyone's quotes compared the staff ENUM with MANAGER, ADMIN
-- (and SUPER_ADMIN); they now ask for this key. It entered the catalog on
-- 2026-11-05 (#96) with no migration, so a Manager or Administrator edited
-- before then never had it, and without this would lose those actions on a
-- screen it opens. Why only this one: a key already in the catalog at the
-- repository's first commit existed when every role was created, so an edited
-- role without it had it unticked (accounting.post for ADMIN, below). Of the
-- seven keys added since, it is the only one a converted check now asks for
-- that no migration granted to edited rows: reporting.all-salespeople, which
-- the salesperson report pickers and Sales by Salesperson now read, was
-- granted by 20261118120000, and sales.undo-handover, admin.audit,
-- sales.cancel-acknowledged, reporting.adhoc and staff.commission-pay gate no
-- check this sweep converted. Two costs, accepted because Holt is pre-launch:
-- an owner who unticked the key for Managers or Administrators after
-- 2026-11-05 gets it back, and a row edited before then also gains what the
-- key has gated since #96 (Follow-Ups, any salesperson's client book,
-- assigning clients nobody owns), which an unedited Manager already holds.
-- GENERAL_MANAGER holds the key by default but passed none of the Pipeline
-- checks, so its edited rows get nothing.
--
-- Who gets what here:
--   * SUPER_ADMIN is a wildcard role: it holds every key and stores no rows.
--   * Built-in roles nobody has edited get the keys from syncBuiltInRoles() on
--     the next deploy (they are in their BUILT_IN_ROLES lists). The seeder never
--     touches an edited built-in (grantsCustomized), so the statements below
--     grant the keys by role key, edited or not; an unedited role ends up with
--     the same grants either way. ADMIN's list is every key outside the owner
--     tier, so an edited ADMIN gets all eleven. accounting.post is not new, and
--     an edited ADMIN without it had it unticked, so it goes to MANAGER only.
--   * Custom roles (isSystem = false) write the enum DESIGNER for their staff.
--     Of the lists these keys replace, only the address list named DESIGNER, so
--     custom roles get customer.address and nothing else. A custom role that
--     grants every permission needs no rows.
--   * GENERAL_MANAGER passed none of these lists and gets nothing.
--
-- Known gap, as in 20260930120000 and 20261118120000: the lists read the staff
-- ENUM, the keys read the role the staff member is linked to (roleId). Staff
-- whose enum and roleId disagree are now decided by the linked role. Untick a
-- key in Roles to narrow, tick it to widen.
--
-- A migration, not a seed step: a seed step would grant a key again after the
-- owner unticks it. Idempotent: an existing grant is left alone.

-- Work B2B proposals
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'sales.proposal'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MANAGER')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Set trade accounts and tax exemptions
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'customer.trade'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MANAGER')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Edit customer addresses: the built-in roles on its list, and every custom role
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'customer.address'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND (
    "key" IN ('ADMIN', 'MANAGER', 'DESIGNER', 'WAREHOUSE', 'MARKETING')
    OR NOT "isSystem"
  )
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- See wealth data
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'customer.wealth'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MARKETING')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Refund returns
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'payment.return-refund'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MANAGER', 'REGISTER', 'WAREHOUSE')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Bill customers directly
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'accounting.invoice'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MANAGER')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Set up the chart of accounts
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'accounting.chart.manage'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MANAGER')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Set up service
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'service.setup'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MANAGER')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- View management reports
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'reporting.management'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MANAGER')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- View financial reports
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'reporting.financial'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- See customer lists
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'marketing.lists'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MARKETING')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Post journals, for MANAGER only (see above)
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'accounting.post'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('MANAGER')
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- Manage client books, for MANAGER and ADMIN (see above). An unedited row holds
-- it already from the seeder, so this changes only the edited ones.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'sales.clients.manage'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MANAGER')
ON CONFLICT ("roleId", "permission") DO NOTHING;
