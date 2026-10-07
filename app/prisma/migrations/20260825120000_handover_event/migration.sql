-- The canonical handover fact: when the goods actually reached the customer,
-- however they got there. Nothing recorded this before -- delivery, pickup and
-- take-with each left their trace somewhere different, and none of them on the
-- order.
ALTER TABLE "SalesOrder" ADD COLUMN "deliveredAt" TIMESTAMP(3);

-- Backfill from the one place a real handover was ever recorded: a completed
-- delivery stop. Pickup and take-with left no evidence to recover.
UPDATE "SalesOrder" o
SET "deliveredAt" = s."completedAt"
FROM "DeliveryStop" s
JOIN "ServiceAppointment" a ON a."id" = s."serviceAppointmentId"
WHERE a."salesOrderId" = o."id"
  AND s."status" = 'COMPLETED'
  AND s."completedAt" IS NOT NULL
  AND o."deliveredAt" IS NULL;

-- FAILED is gone; see the enum's comment in schema.prisma. No row anywhere has
-- ever held it, so this drops a value rather than migrating data.
ALTER TYPE "DeliveryStopStatus" RENAME TO "DeliveryStopStatus_old";
CREATE TYPE "DeliveryStopStatus" AS ENUM ('PENDING', 'EN_ROUTE', 'ARRIVED', 'COMPLETED');
ALTER TABLE "DeliveryStop"
  ALTER COLUMN "status" DROP DEFAULT,
  ALTER COLUMN "status" TYPE "DeliveryStopStatus" USING ("status"::text::"DeliveryStopStatus"),
  ALTER COLUMN "status" SET DEFAULT 'PENDING';
DROP TYPE "DeliveryStopStatus_old";
