-- Helpdesk ticket file attachments (screenshots, PDFs) — uploaded from the
-- staff ticket detail or the public token-authed status page.

CREATE TABLE "TicketAttachment" (
    "id" SERIAL NOT NULL,
    "ticketId" INTEGER NOT NULL,
    "filename" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "bytes" INTEGER,
    "uploadedBy" TEXT,
    "created" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TicketAttachment_ticketId_idx" ON "TicketAttachment"("ticketId");

ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
