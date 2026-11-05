-- AlterTable
ALTER TABLE "StaffMember" ADD COLUMN     "followUpEmailOff" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "followUpEmailHour" INTEGER,
ADD COLUMN     "followUpEmailedOn" TEXT,
ADD COLUMN     "outreachLapsedMonths" INTEGER,
ADD COLUMN     "outreachMinLifetimeSpend" DECIMAL(12,2),
ADD COLUMN     "outreachQuietDays" INTEGER;

-- The morning email's hour, and who gets suggested (lib/followUpEmail.ts, lib/clientBook.ts).
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_followUpEmailHour_range" CHECK (
  "followUpEmailHour" IS NULL OR "followUpEmailHour" BETWEEN 0 AND 23
);
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_outreachMinLifetimeSpend_positive" CHECK (
  "outreachMinLifetimeSpend" IS NULL OR "outreachMinLifetimeSpend" > 0
);
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_outreachLapsedMonths_range" CHECK (
  "outreachLapsedMonths" IS NULL OR "outreachLapsedMonths" BETWEEN 1 AND 120
);
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_outreachQuietDays_range" CHECK (
  "outreachQuietDays" IS NULL OR "outreachQuietDays" BETWEEN 1 AND 3650
);
