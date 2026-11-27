-- Card readers (GAP-03): a reader the store registered with its card
-- processor, and the register it takes payments for. Holt holds only the
-- processor's references; no card data.
CREATE TABLE "CardReader" (
    "id" SERIAL NOT NULL,
    "label" TEXT NOT NULL,
    "registerId" INTEGER,
    "processorType" TEXT NOT NULL,
    "processorReaderId" TEXT NOT NULL,
    "processorLocationId" TEXT,
    "deviceType" TEXT,
    "serialNumber" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "CardReader_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CardReader_registerId_key" ON "CardReader"("registerId");

CREATE UNIQUE INDEX "CardReader_processorReaderId_key" ON "CardReader"("processorReaderId");

ALTER TABLE "CardReader" ADD CONSTRAINT "CardReader_registerId_fkey" FOREIGN KEY ("registerId") REFERENCES "Register"("id") ON DELETE SET NULL ON UPDATE CASCADE;
