-- AlterTable
ALTER TABLE "Vendor" ADD COLUMN     "dropShips" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN     "dropShipAddressId" INTEGER;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_dropShipAddressId_fkey" FOREIGN KEY ("dropShipAddressId") REFERENCES "CustomerAddress"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
