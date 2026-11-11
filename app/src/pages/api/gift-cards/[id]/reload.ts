// /app/src/pages/api/gift-cards/[id]/reload.ts
//
// Put value on a card through the one card ledger (lib/giftCardLedger.ts): a locked change with
// its history row, refused on a retired card. It still takes no payment of its own; selling and
// reloading a card as a line on a sale is the next change (owner, 2026-11-11).

import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/auth/requireAuth";
import { creditToCard, GiftCardError, parseCardAmount } from "@/lib/giftCardLedger";
import { logError } from "@/lib/logger";

export default requirePermission("payment.giftcard.issue", async (req, res, session) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  const id = Number.parseInt(req.query.id as string, 10);
  if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid gift card ID" });
  const createdBy = session.user?.email || null;

  try {
    const amount = parseCardAmount(req.body?.amount);
    const reference = typeof req.body?.reference === "string" ? req.body.reference : null;
    const card = await prisma.$transaction(async (tx) => {
      await creditToCard(tx, { cardId: id, amount, type: "RELOAD", createdBy, reference });
      return tx.giftCard.findUniqueOrThrow({ where: { id } });
    });
    return res.status(200).json({
      card: {
        ...card,
        initialAmount: Number(card.initialAmount),
        currentBalance: Number(card.currentBalance),
      },
    });
  } catch (err: unknown) {
    if (err instanceof GiftCardError) {
      const status = err.message === "Gift card not found" ? 404 : 400;
      return res.status(status).json({ error: err.message });
    }
    logError("POST /gift-cards/[id]/reload error", err);
    return res.status(500).json({ error: "Failed to reload gift card" });
  }
});
