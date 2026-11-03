-- GAP-07, invoice tools.
--   OrderLineItem.notes            staff's note on a line, printed and searchable
--   OrderFlag / SalesOrderFlag     the store's own flags, and the orders they are on
--   OrderDisclaimer                the store's own disclaimers
--   SalesOrderDisclaimer           a disclaimer on an order, its text copied as it
--                                  read, so editing the store's list changes no order
-- All additive: a nullable column and four new tables.

-- AlterTable
ALTER TABLE "OrderLineItem" ADD COLUMN     "notes" TEXT;

-- CreateTable
CREATE TABLE "OrderFlag" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT 'gray',
    "alertOnOpen" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "OrderFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderFlag" (
    "salesOrderId" INTEGER NOT NULL,
    "orderFlagId" INTEGER NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "SalesOrderFlag_pkey" PRIMARY KEY ("salesOrderId","orderFlagId")
);

-- CreateTable
CREATE TABLE "OrderDisclaimer" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "OrderDisclaimer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesOrderDisclaimer" (
    "id" SERIAL NOT NULL,
    "salesOrderId" INTEGER NOT NULL,
    "orderDisclaimerId" INTEGER,
    "text" TEXT NOT NULL,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "SalesOrderDisclaimer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderFlag_name_key" ON "OrderFlag"("name");

-- CreateIndex
CREATE INDEX "SalesOrderFlag_orderFlagId_idx" ON "SalesOrderFlag"("orderFlagId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderDisclaimer_name_key" ON "OrderDisclaimer"("name");

-- CreateIndex
CREATE INDEX "SalesOrderDisclaimer_orderDisclaimerId_idx" ON "SalesOrderDisclaimer"("orderDisclaimerId");

-- CreateIndex
CREATE UNIQUE INDEX "SalesOrderDisclaimer_salesOrderId_orderDisclaimerId_key" ON "SalesOrderDisclaimer"("salesOrderId", "orderDisclaimerId");

-- AddForeignKey
ALTER TABLE "SalesOrderFlag" ADD CONSTRAINT "SalesOrderFlag_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderFlag" ADD CONSTRAINT "SalesOrderFlag_orderFlagId_fkey" FOREIGN KEY ("orderFlagId") REFERENCES "OrderFlag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderDisclaimer" ADD CONSTRAINT "SalesOrderDisclaimer_salesOrderId_fkey" FOREIGN KEY ("salesOrderId") REFERENCES "SalesOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesOrderDisclaimer" ADD CONSTRAINT "SalesOrderDisclaimer_orderDisclaimerId_fkey" FOREIGN KEY ("orderDisclaimerId") REFERENCES "OrderDisclaimer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
