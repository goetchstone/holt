-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "emailAccentColor" TEXT,
ADD COLUMN     "emailFooter" TEXT,
ADD COLUMN     "emailShowLogo" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EmailWording" (
    "key" TEXT NOT NULL,
    "subject" TEXT,
    "heading" TEXT,
    "intro" TEXT,
    "closing" TEXT,
    "updated" TIMESTAMP(3),
    "updatedBy" TEXT,

    CONSTRAINT "EmailWording_pkey" PRIMARY KEY ("key")
);

-- An email's colour goes into a style attribute, so only a plain #rrggbb is let in.
ALTER TABLE "AppSettings" ADD CONSTRAINT "AppSettings_emailAccentColor_hex" CHECK (
  "emailAccentColor" IS NULL OR "emailAccentColor" ~ '^#[0-9a-fA-F]{6}$'
);
