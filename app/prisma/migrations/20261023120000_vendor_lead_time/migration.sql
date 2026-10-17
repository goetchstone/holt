-- A vendor's standard lead time, in days from order to arrival.
--
-- Nothing recorded how long a vendor takes, so a special-order PO raised at
-- the register carried no expected date at all, and nothing could tell a buyer
-- which open POs were late. Nullable: an existing vendor's lead time is not
-- known until someone enters it, and inventing one would put a false date on
-- every PO raised against it.
ALTER TABLE "Vendor" ADD COLUMN "leadTimeDays" INTEGER;
