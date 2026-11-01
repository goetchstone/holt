// /app/src/pages/api/inventory/set-aside/damaged.ts
//
// GAP-16: set stock aside as damaged. POST { positionId, quantity, note } moves
// that many units from the position's place into its store's quarantine place,
// with what is wrong on the journal (lib/inventory/setAside.ts). Changing what
// is for sale is an adjustment, so it needs "Adjust inventory".

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";
import { SetAsideError, setAsideDamaged } from "@/lib/inventory/setAside";

export async function handler(req: NextApiRequest, res: NextApiResponse, session: Session | null) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const { positionId, quantity, note } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof positionId !== "number" || !Number.isInteger(positionId)) {
    return badRequest(res, "positionId must be a stock position id.");
  }
  try {
    const result = await prisma.$transaction((tx) =>
      setAsideDamaged(tx, { positionId, quantity, note, actor: session?.user?.email ?? null }),
    );
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof SetAsideError) return res.status(err.status).json({ error: err.message });
    return handleError(res, err, "POST /inventory/set-aside/damaged");
  }
}

export default requirePermission("inventory.adjust", handler);
