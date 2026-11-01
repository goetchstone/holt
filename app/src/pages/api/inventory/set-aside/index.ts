// /app/src/pages/api/inventory/set-aside/index.ts
//
// GAP-16: stock set aside in quarantine -- damaged, a wrong item, an incomplete
// set -- oldest first (lib/inventory/setAside.ts setAsideStock). A store's
// returns place is left out: the returned-stock queue looks after it.
// ?storeLocationId= narrows it to one store.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";
import { setAsideStock } from "@/lib/inventory/setAside";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const storeLocationId = req.query.storeLocationId ? Number(req.query.storeLocationId) : null;
  if (storeLocationId != null && !Number.isInteger(storeLocationId)) {
    return badRequest(res, "storeLocationId must be a store id.");
  }
  try {
    return res.status(200).json({ items: await setAsideStock(prisma, { storeLocationId }) });
  } catch (err) {
    return handleError(res, err, "GET /inventory/set-aside");
  }
}

export default requirePermission("inventory.read", handler);
