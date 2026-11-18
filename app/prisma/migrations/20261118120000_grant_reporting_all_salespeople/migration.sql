-- "See every salesperson's numbers" (reporting.all-salespeople), 2026-11-18.
--
-- Before this key existed, the Monthly Performance, Salesperson Detail and
-- Designer Dashboard procedures let a caller pick any salesperson only when
-- their staff ENUM (the session token's role) was MANAGER, ADMIN or
-- SUPER_ADMIN, a hardcoded list a store could not change. Everyone else was
-- scoped to their own staff record.
--
-- The switch starts on for exactly that audience, so nobody's view changes:
--   * SUPER_ADMIN is a wildcard role and holds every key with no rows.
--   * ADMIN and MANAGER get the key from syncBuiltInRoles() when nobody has
--     edited them (it is in their BUILT_IN_ROLES lists). The seeder never
--     touches an edited built-in (grantsCustomized), so this grants it there.
--   * Custom roles carry the enum DESIGNER (see 20260930120000), so none of
--     their staff could pick a salesperson; they get nothing. GENERAL_MANAGER
--     was not in the old list either.
--
-- Known gap, as in 20260930120000: the old check read the staff ENUM, this
-- reads the role. Staff whose enum was MANAGER but whose roleId points at
-- another role lose "any salesperson"; granting that role instead would give it
-- to everyone on it. Untick the key in Roles to narrow, tick it to widen.
--
-- A migration, not a seed step: a seed step would grant it again after the
-- owner unticks it. Idempotent.

INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'reporting.all-salespeople'
FROM "Role"
WHERE NOT "grantsAllPermissions"
  AND "key" IN ('ADMIN', 'MANAGER')
ON CONFLICT ("roleId", "permission") DO NOTHING;
