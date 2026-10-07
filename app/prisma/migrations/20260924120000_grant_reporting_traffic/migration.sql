-- SEC-13 tranche 3 (2026-09-24): "View store traffic" (reporting.traffic).
--
-- Before this key existed, GET /api/axper/traffic checked only for a session,
-- so every signed-in staff member saw the home page's door-counter figures.
-- The owner chose a switch that starts ON: nobody loses the figures on day
-- one, and unticking the key in Admin > Setup > Roles takes them away.
--
-- Built-in roles nobody has edited get the key from syncBuiltInRoles() on the
-- next deploy (it is in their BUILT_IN_ROLES lists). The seeder never touches
-- the grants of a built-in role a deployment has edited (grantsCustomized) or
-- of a role the deployment built itself (isSystem = false), so without this
-- statement those roles would lose the figures. It has to be a migration, not
-- a seed step: a seed step runs on every deploy and would grant the key again
-- after the owner unticks it.
--
-- Wildcard roles (grantsAllPermissions) hold every key already and store no
-- rows. Idempotent: an existing grant is left alone.

INSERT INTO "RolePermission" ("roleId", "permission")
SELECT "id", 'reporting.traffic'
FROM "Role"
WHERE NOT "grantsAllPermissions"
ON CONFLICT ("roleId", "permission") DO NOTHING;
