-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_salesOrderId_fkey";

-- AlterTable
ALTER TABLE "Invoice" ALTER COLUMN "salesOrderId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
