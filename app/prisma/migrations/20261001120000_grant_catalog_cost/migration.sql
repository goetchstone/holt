-- SEC-14 (2026-10-01): "View cost" (catalog.cost).
--
-- Before this key, cost went to whoever could open a screen that showed it.
-- The key is enforced screen by screen (see its description in
-- permissionCatalog.ts), but it is granted ONCE, here, for every screen it will
-- cover, to every role as it stands when this runs, so a role that exists now
-- keeps all the cost it sees through every later release. A role created or
-- edited after this runs has whatever its View cost box says; each release
-- that moves another screen under the key says so in its notes. It starts on
-- for exactly the roles that reach cost today:
--   * role lists keyed on the enum: proposals, the MANAGER/ADMIN reports, PO
--     gaps, the consignment report, the query builder (ADMIN, MANAGER);
--   * screens behind catalog.read, catalog.write, inventory.read,
--     reporting.read or admin.settings;
--   * PO list/detail, receiving and inbound ([MANAGER, ADMIN, WAREHOUSE] over
--     purchasing.read / purchasing.receive);
--   * consignment payments and unpaid sales (an accounting.read page over
--     purchasing.write data).
-- Custom roles carry the enum DESIGNER, so no role list admits them; only the
-- key clauses apply. Payload-only, upload-echo, accounting and admin.data paths
-- are left out on purpose: a role reaching only those loses nothing.
--
-- Known gap (as SEC-15): role lists read the staff ENUM, this reads Role.key.
-- Staff whose enum and roleId drifted apart are not covered.
--
-- Unedited built-ins get the key from syncBuiltInRoles() (their BUILT_IN_ROLES
-- lists, which equal this rule). The seeder never touches edited built-ins
-- (grantsCustomized) or custom roles, so this grants it to them. A migration,
-- not a seed step: a seed step would grant it again after the owner unticks it.
-- Wildcard roles hold every key and store no rows. Idempotent.

INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", 'catalog.cost'
FROM "Role" r
WHERE NOT r."grantsAllPermissions"
  AND (
    r."key" IN ('ADMIN', 'MANAGER')
    OR EXISTS (
      SELECT 1 FROM "RolePermission" rp
      WHERE rp."roleId" = r."id"
        AND rp."permission" IN ('catalog.read', 'catalog.write', 'inventory.read', 'reporting.read', 'admin.settings')
    )
    OR (
      r."key" = 'WAREHOUSE'
      AND EXISTS (
        SELECT 1 FROM "RolePermission" rp
        WHERE rp."roleId" = r."id" AND rp."permission" IN ('purchasing.read', 'purchasing.receive')
      )
    )
    OR (
      EXISTS (SELECT 1 FROM "RolePermission" rp WHERE rp."roleId" = r."id" AND rp."permission" = 'accounting.read')
      AND EXISTS (SELECT 1 FROM "RolePermission" rp WHERE rp."roleId" = r."id" AND rp."permission" = 'purchasing.write')
    )
  )
ON CONFLICT ("roleId", "permission") DO NOTHING;
