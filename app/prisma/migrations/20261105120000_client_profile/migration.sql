-- GAP-36: what a salesperson keeps on file about a client, and this store's choices for
-- that form. Null choices use the suggestions in lib/clientProfile.ts.
-- AlterTable
ALTER TABLE "AppSettings" ADD COLUMN     "clientProfileChoices" JSONB;

-- CreateTable
CREATE TABLE "ClientProfile" (
    "id" SERIAL NOT NULL,
    "customerId" INTEGER NOT NULL,
    "projectDescription" TEXT,
    "stylePreferences" TEXT,
    "homes" TEXT,
    "preferredBrands" TEXT,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roomsOfInterest" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "residenceType" TEXT,
    "projectTimeline" TEXT,
    "budgetRange" TEXT,
    "decisionMaker" TEXT,
    "closeLikelihood" INTEGER,
    "expectedCloseDate" DATE,
    "nextSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nextFollowUpDate" DATE,
    "searchText" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ClientProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClientProfile_customerId_key" ON "ClientProfile"("customerId");

-- AddForeignKey
ALTER TABLE "ClientProfile" ADD CONSTRAINT "ClientProfile_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClientProfile" ADD CONSTRAINT "ClientProfile_closeLikelihood_range" CHECK (
  "closeLikelihood" IS NULL OR "closeLikelihood" BETWEEN 1 AND 10
);
