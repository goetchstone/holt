// /app/src/pages/api/gift-cards/[id]/replace.ts
//
// Retire a card by moving its whole balance to a new card (owner, 2026-11-11: "the only thing I
// can see doing is issuing a new one using the old one to pay for the new one"). The old card ends
// at $0, REPLACED and linked to the new one; both keep their history (lib/giftCardLedger.ts).
// This replaces Void, which made a balance vanish. The two TRANSFER rows are the record: the
// audit trail reads gift-card history from GiftCardTransaction (lib/auditCatalog.ts).

import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { GiftCardError, replaceCard } from "@/lib/giftCardLedger";
import { logError } from "@/lib/logger";

export default requirePermission("payment.giftcard.issue", async (req, res, session) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid gift card ID" });
  const barcode = typeof req.body?.barcode === "string" ? req.body.barcode : "";
  const createdBy = session.user?.email || null;

  try {
    const result = await prisma.$transaction((tx) =>
      replaceCard(tx, { cardId: id, newBarcode: barcode, createdBy }),
    );
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof GiftCardError) {
      const status = err.message === "Gift card not found" ? 404 : 400;
      return res.status(status).json({ error: err.message });
    }
    logError("POST /gift-cards/[id]/replace error", err);
    return res.status(500).json({ error: "Failed to move the card's balance" });
  }
});
