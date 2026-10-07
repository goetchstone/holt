-- Role / RolePermission: the DATA half of authorization.
--
-- src/lib/auth/permissionCatalog.ts has declared 45 permissions and 8 built-in
-- roles since PR #67, and its header describes grants as living in "Role +
-- RolePermission rows". Those tables did not exist. This migration creates
-- them, links StaffMember to Role, and backfills every existing staff member so
-- that introducing the layer changes nothing on day one.
--
-- StaffMember keeps BOTH `role` (the StaffRole enum) and `roleId` (this FK).
-- 334 of 335 API routes still gate on the enum via requireAuthWithRole; the FK
-- is nullable and additive so routes can move to requirePermission one at a
-- time. See docs/DECISIONS.md and schema.prisma's doc comments.
--
-- The role + grant rows below are a POINT-IN-TIME SNAPSHOT of BUILT_IN_ROLES.
-- They are here so that any path that runs `prisma migrate deploy` -- the
-- container entrypoint, scripts/setup.sh, scripts/deploy.sh's one-off container
-- -- ends with a usable installation even if nothing else runs. The snapshot is
-- not the source of truth and is never edited again: syncBuiltInRoles()
-- (src/lib/auth/builtInRoles.ts) reconciles these rows against the catalog on
-- every deploy, which is what carries a permission added by a later release
-- onto the built-in roles that should hold it.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE "Role" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    -- Grants every permission including future ones. A boolean, not 45 rows:
    -- see the doc comment in schema.prisma for why materialising the wildcard
    -- would silently strip the Owner of each new release's permissions.
    "grantsAllPermissions" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    -- Anti-escalation rank only (lib/auth/roleDecision.ts). 0 = lateral.
    "rank" INTEGER NOT NULL DEFAULT 0,
    -- Set once a deployment edits a built-in role's grants; the seeder then
    -- stops reconciling them.
    "grantsCustomized" BOOLEAN NOT NULL DEFAULT false,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Role_key_key" ON "Role"("key");
CREATE INDEX "Role_isSystem_idx" ON "Role"("isSystem");

CREATE TABLE "RolePermission" (
    "id" SERIAL NOT NULL,
    "roleId" INTEGER NOT NULL,
    -- A key from PERMISSIONS in lib/auth/permissionCatalog.ts. Text, not an
    -- enum, so the catalog stays the single source of truth and a config preset
    -- can name a key without a schema migration. Postgres therefore cannot
    -- validate it -- findOrphanPermissionKeys() is the check that catches a key
    -- left behind by a rename, and the seeder runs it on every deploy.
    "permission" TEXT NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RolePermission_roleId_permission_key" ON "RolePermission"("roleId", "permission");
CREATE INDEX "RolePermission_permission_idx" ON "RolePermission"("permission");

ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Built-in roles (snapshot of BUILT_IN_ROLES)
-- ---------------------------------------------------------------------------

INSERT INTO "Role" ("key", "name", "description", "grantsAllPermissions", "isSystem", "rank")
VALUES
    ('SUPER_ADMIN', 'Owner', 'Unrestricted. Holds every permission, including ones added by future releases.', true, true, 3),
    ('ADMIN', 'Administrator', 'Everything except the owner-only tier.', false, true, 2),
    ('MANAGER', 'Manager', 'Runs the store day to day: money, people, stock, and the books they touch.', false, true, 1),
    ('DESIGNER', 'Designer', 'Sells: writes orders and works customers. No refunds, no pricing, no discounts by default.', false, true, 0),
    ('REGISTER', 'Register', 'Counter staff: rings sales and takes payment, cannot refund.', false, true, 0),
    ('WAREHOUSE', 'Warehouse', 'Receives, moves and dispatches stock.', false, true, 0),
    ('INSTALLER', 'Installer', 'Delivers and services in the field.', false, true, 0),
    ('MARKETING', 'Marketing', 'Campaigns, leads and list sync.', false, true, 0)
ON CONFLICT ("key") DO NOTHING;

-- SUPER_ADMIN gets no rows at all -- grantsAllPermissions covers it, which is
-- the whole point of the flag.
INSERT INTO "RolePermission" ("roleId", "permission")
SELECT r."id", g."permission"
FROM (VALUES
    ('ADMIN', 'sales.read'),
    ('ADMIN', 'sales.write'),
    ('ADMIN', 'sales.discount'),
    ('ADMIN', 'sales.cancel'),
    ('ADMIN', 'sales.reassign'),
    ('ADMIN', 'pos.operate'),
    ('ADMIN', 'pos.till.manage'),
    ('ADMIN', 'pos.till.adjust'),
    ('ADMIN', 'payment.take'),
    ('ADMIN', 'payment.refund'),
    ('ADMIN', 'payment.void'),
    ('ADMIN', 'payment.giftcard.issue'),
    ('ADMIN', 'customer.read'),
    ('ADMIN', 'customer.write'),
    ('ADMIN', 'customer.credit.adjust'),
    ('ADMIN', 'catalog.read'),
    ('ADMIN', 'catalog.write'),
    ('ADMIN', 'catalog.pricing'),
    ('ADMIN', 'inventory.read'),
    ('ADMIN', 'inventory.count'),
    ('ADMIN', 'inventory.adjust'),
    ('ADMIN', 'inventory.transfer'),
    ('ADMIN', 'purchasing.read'),
    ('ADMIN', 'purchasing.write'),
    ('ADMIN', 'purchasing.receive'),
    ('ADMIN', 'warehouse.read'),
    ('ADMIN', 'warehouse.operate'),
    ('ADMIN', 'service.read'),
    ('ADMIN', 'service.write'),
    ('ADMIN', 'accounting.read'),
    ('ADMIN', 'accounting.post'),
    ('ADMIN', 'accounting.close'),
    ('ADMIN', 'reporting.read'),
    ('ADMIN', 'reporting.export'),
    ('ADMIN', 'marketing.read'),
    ('ADMIN', 'marketing.write'),
    ('ADMIN', 'staff.read'),
    ('ADMIN', 'staff.time'),
    ('ADMIN', 'staff.manage'),
    ('ADMIN', 'staff.commission'),
    ('ADMIN', 'admin.settings'),
    ('ADMIN', 'admin.integrations'),
    ('ADMIN', 'admin.config'),
    ('ADMIN', 'admin.data'),
    ('MANAGER', 'sales.read'),
    ('MANAGER', 'sales.write'),
    ('MANAGER', 'sales.discount'),
    ('MANAGER', 'sales.cancel'),
    ('MANAGER', 'sales.reassign'),
    ('MANAGER', 'pos.operate'),
    ('MANAGER', 'pos.till.manage'),
    ('MANAGER', 'pos.till.adjust'),
    ('MANAGER', 'payment.take'),
    ('MANAGER', 'payment.refund'),
    ('MANAGER', 'payment.void'),
    ('MANAGER', 'payment.giftcard.issue'),
    ('MANAGER', 'customer.read'),
    ('MANAGER', 'customer.write'),
    ('MANAGER', 'customer.credit.adjust'),
    ('MANAGER', 'catalog.read'),
    ('MANAGER', 'catalog.write'),
    ('MANAGER', 'catalog.pricing'),
    ('MANAGER', 'inventory.read'),
    ('MANAGER', 'inventory.count'),
    ('MANAGER', 'inventory.adjust'),
    ('MANAGER', 'inventory.transfer'),
    ('MANAGER', 'purchasing.read'),
    ('MANAGER', 'purchasing.write'),
    ('MANAGER', 'purchasing.receive'),
    ('MANAGER', 'warehouse.read'),
    ('MANAGER', 'warehouse.operate'),
    ('MANAGER', 'service.read'),
    ('MANAGER', 'service.write'),
    ('MANAGER', 'accounting.read'),
    ('MANAGER', 'reporting.read'),
    ('MANAGER', 'reporting.export'),
    ('MANAGER', 'marketing.read'),
    ('MANAGER', 'marketing.write'),
    ('MANAGER', 'staff.read'),
    ('MANAGER', 'staff.time'),
    ('MANAGER', 'staff.commission'),
    ('DESIGNER', 'sales.read'),
    ('DESIGNER', 'sales.write'),
    ('DESIGNER', 'customer.read'),
    ('DESIGNER', 'customer.write'),
    ('DESIGNER', 'catalog.read'),
    ('DESIGNER', 'inventory.read'),
    ('DESIGNER', 'purchasing.read'),
    ('DESIGNER', 'service.read'),
    ('DESIGNER', 'service.write'),
    ('DESIGNER', 'reporting.read'),
    ('REGISTER', 'sales.read'),
    ('REGISTER', 'sales.write'),
    ('REGISTER', 'pos.operate'),
    ('REGISTER', 'pos.till.manage'),
    ('REGISTER', 'payment.take'),
    ('REGISTER', 'customer.read'),
    ('REGISTER', 'customer.write'),
    ('REGISTER', 'catalog.read'),
    ('REGISTER', 'inventory.read'),
    ('WAREHOUSE', 'sales.read'),
    ('WAREHOUSE', 'catalog.read'),
    ('WAREHOUSE', 'inventory.read'),
    ('WAREHOUSE', 'inventory.count'),
    ('WAREHOUSE', 'inventory.transfer'),
    ('WAREHOUSE', 'purchasing.read'),
    ('WAREHOUSE', 'purchasing.receive'),
    ('WAREHOUSE', 'warehouse.read'),
    ('WAREHOUSE', 'warehouse.operate'),
    ('INSTALLER', 'sales.read'),
    ('INSTALLER', 'customer.read'),
    ('INSTALLER', 'warehouse.read'),
    ('INSTALLER', 'warehouse.operate'),
    ('INSTALLER', 'service.read'),
    ('INSTALLER', 'service.write'),
    ('MARKETING', 'customer.read'),
    ('MARKETING', 'catalog.read'),
    ('MARKETING', 'marketing.read'),
    ('MARKETING', 'marketing.write'),
    ('MARKETING', 'reporting.read')
) AS g("roleKey", "permission")
JOIN "Role" r ON r."key" = g."roleKey"
ON CONFLICT ("roleId", "permission") DO NOTHING;

-- ---------------------------------------------------------------------------
-- StaffMember.roleId + backfill
-- ---------------------------------------------------------------------------

ALTER TABLE "StaffMember" ADD COLUMN "roleId" INTEGER;

-- The backfill is the guarantee that nothing changes on day one: every staff
-- member ends up pointing at the Role whose key is exactly their existing
-- StaffRole value. This join only works because the eight BUILT_IN_ROLES keys
-- are exactly the eight StaffRole enum values -- verified against
-- schema.prisma's enum, and kept true by the tripwire in
-- __tests__/rolePermissionSchema.test.ts.
UPDATE "StaffMember" s
SET "roleId" = r."id"
FROM "Role" r
WHERE r."key" = s."role"::text
  AND s."roleId" IS NULL;

-- Fail loudly rather than silently orphaning a staff member. A NULL survivor
-- here means an enum value with no matching Role, i.e. the two lists drifted;
-- shipping past that would leave someone falling back to the enum path forever
-- with nobody the wiser.
DO $$
DECLARE orphaned INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphaned FROM "StaffMember" WHERE "roleId" IS NULL;
  IF orphaned > 0 THEN
    RAISE EXCEPTION 'roleId backfill left % StaffMember row(s) unlinked: a StaffRole enum value has no matching Role.key', orphaned;
  END IF;
END $$;

CREATE INDEX "StaffMember_roleId_idx" ON "StaffMember"("roleId");

ALTER TABLE "StaffMember" ADD CONSTRAINT "StaffMember_roleId_fkey"
    FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE SET NULL ON UPDATE CASCADE;
