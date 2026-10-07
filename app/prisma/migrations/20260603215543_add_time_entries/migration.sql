-- CreateTable
CREATE TABLE "TimeEntry" (
    "id" SERIAL NOT NULL,
    "organizationId" INTEGER NOT NULL,
    "staffMemberId" INTEGER NOT NULL,
    "customerId" INTEGER,
    "description" TEXT NOT NULL,
    "minutes" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "isBillable" BOOLEAN NOT NULL DEFAULT true,
    "billedAt" TIMESTAMP(3),
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "TimeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TimeEntry_organizationId_date_idx" ON "TimeEntry"("organizationId", "date");

-- CreateIndex
CREATE INDEX "TimeEntry_staffMemberId_date_idx" ON "TimeEntry"("staffMemberId", "date");

-- CreateIndex
CREATE INDEX "TimeEntry_customerId_idx" ON "TimeEntry"("customerId");

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_staffMemberId_fkey" FOREIGN KEY ("staffMemberId") REFERENCES "StaffMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
