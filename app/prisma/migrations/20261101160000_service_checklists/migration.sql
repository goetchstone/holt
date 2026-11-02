-- GAP-11: service checklists (owner, 2026-11-01: task checklists).
--
--   ServiceChecklist       the steps a kind of service job takes, set up by the
--                          store in Settings > Service. None ship.
--   ServiceChecklistStep   one step: a title, a note, and how many days after
--                          the checklist is applied the task is due.
--   ServiceTask.checklistId  the checklist a task was copied from, so a case
--                          isn't given the same one twice. Null on every task
--                          written before this, and on hand-added ones.

-- AlterTable
ALTER TABLE "ServiceTask" ADD COLUMN     "checklistId" INTEGER;

-- CreateTable
CREATE TABLE "ServiceChecklist" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "ServiceChecklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceChecklistStep" (
    "id" SERIAL NOT NULL,
    "checklistId" INTEGER NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "dueAfterDays" INTEGER,

    CONSTRAINT "ServiceChecklistStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ServiceChecklist_name_key" ON "ServiceChecklist"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ServiceChecklistStep_checklistId_position_key" ON "ServiceChecklistStep"("checklistId", "position");

-- CreateIndex
CREATE INDEX "ServiceTask_checklistId_idx" ON "ServiceTask"("checklistId");

-- AddForeignKey
ALTER TABLE "ServiceTask" ADD CONSTRAINT "ServiceTask_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "ServiceChecklist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ServiceChecklistStep" ADD CONSTRAINT "ServiceChecklistStep_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "ServiceChecklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The settings route refuses anything else; these are the floor under it.
ALTER TABLE "ServiceChecklistStep" ADD CONSTRAINT "ServiceChecklistStep_dueAfterDays_range"
  CHECK ("dueAfterDays" IS NULL OR ("dueAfterDays" >= 0 AND "dueAfterDays" <= 365));
ALTER TABLE "ServiceChecklistStep" ADD CONSTRAINT "ServiceChecklistStep_position_nonnegative"
  CHECK ("position" >= 0);
