// /app/src/pages/api/sales/discount-approvers.ts
//
// GAP-06: who can approve a discount at the register: active staff whose role
// holds "Apply discounts" and who have set a PIN (lib/sales/discountApproval.ts).
// Names and ids only; the PIN is checked by the route the approval is sent to.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { methodNotAllowed, handleError } from "@/lib/apiResponse";
import { listDiscountApprovers } from "@/lib/sales/discountApproval";

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  try {
    return res.status(200).json(await listDiscountApprovers(prisma));
  } catch (err) {
    return handleError(res, err, "discount approvers");
  }
}

export default requirePermission("sales.write", handler);
