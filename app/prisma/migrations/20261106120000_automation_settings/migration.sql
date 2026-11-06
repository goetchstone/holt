-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "automationsWokenAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AutomationSetting" (
    "key" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "activeSince" TIMESTAMP(3),
    "frequency" TEXT NOT NULL,
    "everyMinutes" INTEGER,
    "hour" INTEGER,
    "weekday" INTEGER,
    "lastStartedAt" TIMESTAMP(3),
    "lastFinishedAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastSummary" TEXT,
    "updated" TIMESTAMP(3),
    "updatedBy" TEXT,

    CONSTRAINT "AutomationSetting_pkey" PRIMARY KEY ("key")
);

-- How often an automation runs is one of four, each with what it needs and nothing else.
ALTER TABLE "AutomationSetting" ADD CONSTRAINT "AutomationSetting_schedule" CHECK (
  ("frequency" = 'EVERY_MINUTES' AND "everyMinutes" >= 5 AND "hour" IS NULL AND "weekday" IS NULL)
  OR ("frequency" = 'HOURLY' AND "everyMinutes" IS NULL AND "hour" IS NULL AND "weekday" IS NULL)
  OR ("frequency" = 'DAILY' AND "everyMinutes" IS NULL AND "hour" BETWEEN 0 AND 23 AND "weekday" IS NULL)
  OR ("frequency" = 'WEEKLY' AND "everyMinutes" IS NULL AND "hour" BETWEEN 0 AND 23 AND "weekday" BETWEEN 0 AND 6)
);
ALTER TABLE "AutomationSetting" ADD CONSTRAINT "AutomationSetting_lastStatus" CHECK (
  "lastStatus" IS NULL OR "lastStatus" IN ('RUNNING', 'OK', 'FAILED', 'SKIPPED')
);
