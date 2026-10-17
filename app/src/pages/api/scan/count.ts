// /app/src/pages/api/scan/count.ts
//
// Submit a handheld count of one place (lib/inventory/count.ts), and post it
// at once when the counter may change the books (inventory.adjust); otherwise
// it waits on Inventory › Counts for someone who may.
//
// POST { actionKey, storeLocationId, stockLocationId, scope: PLACE|PRODUCTS,
//        lines: [{ productId, counted, boxes? }], post?: boolean }

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import type { CallerAccess } from "@/lib/auth/gateOptions";
import { requirePermission } from "@/lib/auth/requireAuth";
import {
  CountError,
  postCount,
  submitCount,
  STOCK_COUNT_SCOPES,
  type StockCountScope,
} from "@/lib/inventory/count";
import { ActionKeyError, parseActionKey, withAction } from "@/lib/inventory/withAction";
import { logError } from "@/lib/logger";

const ADJUST = "inventory.adjust";

export async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const actionKey = parseActionKey(body.actionKey);
  if (actionKey instanceof ActionKeyError)
    return res.status(400).json({ error: actionKey.message });
  const storeLocationId = Number(body.storeLocationId);
  const stockLocationId = Number(body.stockLocationId);
  if (!Number.isInteger(storeLocationId) || !Number.isInteger(stockLocationId)) {
    return res.status(400).json({ error: "storeLocationId and stockLocationId are required." });
  }
  const scope = String(body.scope ?? "PLACE") as StockCountScope;
  if (!Object.hasOwn(STOCK_COUNT_SCOPES, scope)) {
    return res.status(400).json({ error: "scope must be PLACE or PRODUCTS." });
  }
  const wantsPost = body.post === true;
  if (wantsPost && !access.holds[ADJUST]) {
    return res.status(403).json({
      error:
        "Posting a count changes the books: it needs Adjust inventory. Submit it for someone who has it.",
    });
  }
  const lines = Array.isArray(body.lines)
    ? (body.lines as { productId: unknown; counted: unknown; boxes?: unknown }[]).map((l) => ({
        productId: Number(l.productId),
        counted: Number(l.counted),
        boxes: Array.isArray(l.boxes) ? l.boxes.map(Number) : [],
      }))
    : [];
  const actor = session.user?.email || null;
  try {
    const { result, replayed } = await withAction(
      actionKey,
      { kind: "COUNT", actor },
      async (tx) => {
        const count = await submitCount(tx, {
          storeLocationId,
          stockLocationId,
          scope,
          lines,
          actor,
        });
        const diffs = wantsPost ? await postCount(tx, count.id, { actor, actionKey }) : null;
        return {
          countId: count.id,
          posted: wantsPost,
          changed: diffs?.filter((d) => d.difference !== 0).length ?? null,
        };
      },
    );
    return res.status(replayed ? 200 : 201).json({ ...result, replayed });
  } catch (error) {
    if (error instanceof CountError) return res.status(400).json({ error: error.message });
    logError("Error submitting a count", error);
    return res.status(500).json({ error: "Failed to submit the count" });
  }
}

export default requirePermission("inventory.count", handler, { also: [ADJUST] });
