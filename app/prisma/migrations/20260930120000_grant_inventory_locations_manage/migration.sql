-- SEC-15 (2026-09-30): "Set up stores and stock locations" (inventory.locations.manage).
--
-- Who could set up stores before this key existed:
--   * create, edit or delete a store, and create a stock location: a role
--     holding "Transfer stock" AND whose staff enum was MANAGER or ADMIN (a
--     hardcoded check inside the routes, now removed). Custom roles carry the
--     enum DESIGNER, so none of them could; SUPER_ADMIN failed the exact-string
--     check too (a bug this key fixes);
--   * edit or delete a stock location, including its "holds committed stock"
--     flag: a role holding "Adjust inventory".
-- One switch cannot split those two audiences, so it starts on for their
-- UNION: nobody loses a setup action. Two kinds of role gain some:
--   * a role holding "Adjust inventory" that failed the MANAGER/ADMIN check
--     (GENERAL_MANAGER, a custom role, an edited WAREHOUSE with Adjust
--     ticked) also gains store create/edit/delete and stock-location create;
--   * an edited ADMIN/MANAGER holding "Transfer stock" but not "Adjust
--     inventory" also gains stock-location edit/delete, including the
--     committed-stock flag.
-- Untick the switch in Roles to undo either. Unedited WAREHOUSE is left out:
-- it could view locations but not create or change them.
--
-- Known gap: the old check read the staff ENUM, this reads Role.key. Staff
-- whose enum was changed in Admin > Staff before USE-02 (2026-09-24) without
-- their roleId following (e.g. enum MANAGER, roleId WAREHOUSE) lose store
-- setup; granting their role instead would give it to everyone on that role.
-- Tracked separately (repair enum/roleId drift).
--
-- Unedited built-ins get the key from syncBuiltInRoles() on boot (their
-- BUILT_IN_ROLES lists). The seeder never touches edited built-ins
-- (grantsCustomized) or custom roles (isSystem = false), so this grants it to
-- them. It has to be a migration: a seed step would grant it again after the
-- owner unticks it. Wildcard roles hold every key and store no rows.
-- Idempotent.

INSERT INTO "RolePermission" ("roleId", "permission")
SELECT DISTINCT r."id", 'inventory.locations.manage'
FROM "Role" r
JOIN "RolePermission" rp ON rp."roleId" = r."id"
WHERE NOT r."grantsAllPermissions"
  AND (
    rp."permission" = 'inventory.adjust'
    OR (rp."permission" = 'inventory.transfer' AND r."key" IN ('ADMIN', 'MANAGER'))
  )
ON CONFLICT ("roleId", "permission") DO NOTHING;
