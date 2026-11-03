-- GAP-13: messages that send themselves.
--
--   CustomerMessageSetting      each automatic message as the store set it up:
--                               on or off (off to start), wording, link, timing
--   CustomerMessage             each one sent, or deliberately not, per event
--   Customer.autoMessagesOptOut the customer asked for none
-- Additive: two tables and a column with a default.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "autoMessagesOptOut" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CustomerMessageSetting" (
    "kind" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "activeSince" TIMESTAMP(3),
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "includeOrderLink" BOOLEAN NOT NULL DEFAULT true,
    "offsetDays" INTEGER,
    "sendHour" INTEGER,
    "linkUrl" TEXT,
    "updated" TIMESTAMP(3),
    "updatedBy" TEXT,

    CONSTRAINT "CustomerMessageSetting_pkey" PRIMARY KEY ("kind")
);

-- CreateTable
CREATE TABLE "CustomerMessage" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "customerId" INTEGER,
    "status" TEXT NOT NULL,
    "skipReason" TEXT,
    "toAddress" TEXT,
    "emailQueueId" INTEGER,
    "receivingRecordIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMessage_dedupeKey_key" ON "CustomerMessage"("dedupeKey");

-- CreateIndex
CREATE INDEX "CustomerMessage_salesOrderId_idx" ON "CustomerMessage"("salesOrderId");

-- CreateIndex
CREATE INDEX "CustomerMessage_kind_created_idx" ON "CustomerMessage"("kind", "created");

-- AddForeignKey
ALTER TABLE "CustomerMessage" ADD CONSTRAINT "CustomerMessage_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerMessage" ADD CONSTRAINT "CustomerMessage_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A timed message goes out at an hour of the store's day, some days from its
-- event; a message sent is either queued or skipped. The routes check these
-- too; these are the floor under them.
ALTER TABLE "CustomerMessageSetting" ADD CONSTRAINT "CustomerMessageSetting_sendHour_range"
  CHECK ("sendHour" IS NULL OR ("sendHour" >= 0 AND "sendHour" <= 23));
ALTER TABLE "CustomerMessageSetting" ADD CONSTRAINT "CustomerMessageSetting_offsetDays_range"
  CHECK ("offsetDays" IS NULL OR ("offsetDays" >= 0 AND "offsetDays" <= 90));
ALTER TABLE "CustomerMessage" ADD CONSTRAINT "CustomerMessage_status_known"
  CHECK ("status" IN ('QUEUED', 'SKIPPED'));
