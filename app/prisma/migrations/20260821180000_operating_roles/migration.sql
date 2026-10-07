-- The operating roles.
--
-- The original eight StaffRole values described how one retailer happened to be
-- staffed. A Buyer, a Department Head, or anyone in People Operations had to be
-- shoehorned into MANAGER -- which meant granting the whole store to let someone
-- do one job, the opposite of least privilege.
--
-- Adding enum values only. No existing row changes: every staff member keeps the
-- role they have, and nothing is migrated onto these automatically. Which people
-- move is a business decision, made per deployment through Admin > Staff.
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'GENERAL_MANAGER';
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'DEPARTMENT_HEAD';
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'BUYER';
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'DATA_ENTRY';
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'HR';
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'DISPATCH';
ALTER TYPE "StaffRole" ADD VALUE IF NOT EXISTS 'CUSTOMER_SERVICE';
