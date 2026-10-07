-- InventoryException: durable record of an allocation shortfall (a sale that
-- went through oversold). See the model's doc comment in schema.prisma --
-- allocate() never blocks or warns at the register, so this is where the gap
-- lands for back office to work.

CREATE TABLE "InventoryException" (
    "id" SERIAL NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "storeLocationId" INTEGER NOT NULL,
    "requested" INTEGER NOT NULL,
    "allocated" INTEGER NOT NULL,
    "shortfall" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNote" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "InventoryException_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InventoryException_resolvedAt_idx" ON "InventoryException"("resolvedAt");
CREATE INDEX "InventoryException_salesOrderId_idx" ON "InventoryException"("salesOrderId");

ALTER TABLE "InventoryException" ADD CONSTRAINT "InventoryException_salesOrderId_fkey"
    FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryException" ADD CONSTRAINT "InventoryException_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InventoryException" ADD CONSTRAINT "InventoryException_storeLocationId_fkey"
    FOREIGN KEY ("storeLocationId") REFERENCES "StoreLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
