// /app/src/pages/api/sales/delivery-fee-quote.ts
//
// GAP-09: what delivery costs, for the register before a sale exists.
//   GET ?customerId=&pieces=  -> the zone delivering to the customer's address
//   GET ?zip=&pieces=            and its fee (lib/delivery/deliveryFee.ts). A
//                                ZIP, when sent, is used instead of the
//                                customer's.
// The sale itself charges whatever fee the register sends (create-from-cart);
// this only tells staff what the zone charges.

import type { NextApiRequest, NextApiResponse } from "next";
import { requirePermission } from "@/lib/auth/requireAuth";
import { prisma } from "@/lib/prisma";
import { badRequest, methodNotAllowed, handleError } from "@/lib/apiResponse";
import { customerZip, quoteDeliveryFee } from "@/lib/delivery/deliveryFee";

/** A sale's pieces: more than any truck carries is a typo, not a delivery. */
const MAX_PIECES = 10_000;

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);

  const pieces = Number(req.query.pieces ?? 0);
  if (!Number.isInteger(pieces) || pieces < 0 || pieces > MAX_PIECES) {
    return badRequest(res, `pieces must be a whole number from 0 to ${MAX_PIECES}.`);
  }
  const rawCustomer = req.query.customerId;
  const customerId = rawCustomer === undefined || rawCustomer === "" ? null : Number(rawCustomer);
  if (customerId !== null && (!Number.isInteger(customerId) || customerId <= 0)) {
    return badRequest(res, "customerId must be a customer id.");
  }
  const sentZip = typeof req.query.zip === "string" ? req.query.zip.trim() : "";

  try {
    const zip = sentZip || (await customerZip(prisma, customerId));
    return res.status(200).json(await quoteDeliveryFee(prisma, { zip, pieces }));
  } catch (err) {
    return handleError(res, err, "delivery fee quote");
  }
}

export default requirePermission("sales.write", handler);
