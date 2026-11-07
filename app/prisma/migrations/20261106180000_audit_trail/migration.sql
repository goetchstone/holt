-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" SERIAL NOT NULL,
    "event" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "details" JSONB,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEntry_created_idx" ON "AuditEntry"("created");

-- CreateIndex
CREATE INDEX "AuditEntry_actor_created_idx" ON "AuditEntry"("actor", "created");

-- CreateIndex
CREATE INDEX "AuditEntry_event_created_idx" ON "AuditEntry"("event", "created");

-- CreateIndex
CREATE INDEX "StockMovement_occurredAt_idx" ON "StockMovement"("occurredAt");

-- CreateIndex
CREATE INDEX "OrderChangeLog_created_idx" ON "OrderChangeLog"("created");
