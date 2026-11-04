-- GAP-12: texts, through a provider chosen in Settings.
--
--   SmsQueue                    each text waiting, sent or given up on
--   SmsOptOut                   each number that replied STOP
--   Customer.smsConsent*        the customer agreed to texts, and who recorded it
--   Customer.preferredChannel   how they'd rather hear from the store
--   CustomerMessageSetting.*    how each automatic message goes; EMAIL to start
--   CustomerMessage.*           the text beside the email
-- Additive: two tables, and columns that are null or default to what is true now.

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "preferredChannel" TEXT,
ADD COLUMN     "smsConsentAt" TIMESTAMP(3),
ADD COLUMN     "smsConsentBy" TEXT;

-- AlterTable
ALTER TABLE "CustomerMessageSetting" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'EMAIL',
ADD COLUMN     "textBody" TEXT,
ADD COLUMN     "textIncludeOrderLink" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "CustomerMessage" ADD COLUMN     "smsQueueId" INTEGER,
ADD COLUMN     "smsSkipReason" TEXT,
ADD COLUMN     "toPhone" TEXT;

-- CreateTable
CREATE TABLE "SmsQueue" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "toPhone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "templateKey" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,

    CONSTRAINT "SmsQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsOptOut" (
    "phone" TEXT NOT NULL,
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,

    CONSTRAINT "SmsOptOut_pkey" PRIMARY KEY ("phone")
);

-- CreateIndex
CREATE UNIQUE INDEX "SmsQueue_providerMessageId_key" ON "SmsQueue"("providerMessageId");

-- CreateIndex
CREATE INDEX "SmsQueue_organizationId_status_idx" ON "SmsQueue"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SmsQueue_status_scheduledAt_idx" ON "SmsQueue"("status", "scheduledAt");

-- AddForeignKey
ALTER TABLE "SmsQueue" ADD CONSTRAINT "SmsQueue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The channels the routes accept, and numbers in the one form a provider takes.
-- The routes check these too; these are the floor under them.
ALTER TABLE "CustomerMessageSetting" ADD CONSTRAINT "CustomerMessageSetting_channel_known"
  CHECK ("channel" IN ('EMAIL', 'TEXT', 'BOTH', 'CUSTOMER'));
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_preferredChannel_known"
  CHECK ("preferredChannel" IS NULL OR "preferredChannel" IN ('EMAIL', 'TEXT', 'BOTH'));
ALTER TABLE "SmsQueue" ADD CONSTRAINT "SmsQueue_toPhone_e164"
  CHECK ("toPhone" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "SmsOptOut" ADD CONSTRAINT "SmsOptOut_phone_e164"
  CHECK ("phone" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "SmsOptOut" ADD CONSTRAINT "SmsOptOut_source_known"
  CHECK ("source" IN ('REPLY', 'PROVIDER'));
