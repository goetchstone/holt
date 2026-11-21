// /app/src/lib/returns/portalReturn.ts
//
// The customer return portal's server side, pure (rule 14): what the public
// return routes select and send (PortalReturn, portalReturnContract.ts), and the
// request body the customer posts. The routes are public -- the Return's
// portalToken is the only credential -- so the body is checked here before
// anything reaches Prisma: an unknown reason used to reach the ReturnReason
// enum column and come back as a 500.

import { ReturnReason, type Prisma } from "@prisma/client";
import { toQty } from "@/lib/inventory/quantity";
import type { PortalReturn } from "./portalReturnContract";
import { isLineItemId, LINE_ITEM_ID_ERROR } from "./returnLine";

/** The columns behind PortalReturn, and nothing more. */
export const PORTAL_RETURN_SELECT = {
  returnNumber: true,
  status: true,
  productName: true,
  quantity: true,
  created: true,
  customerNotes: true,
} satisfies Prisma.ReturnSelect;

type PortalReturnRow = Prisma.ReturnGetPayload<{ select: typeof PORTAL_RETURN_SELECT }>;

export function toPortalReturn(row: PortalReturnRow): PortalReturn {
  return {
    returnNumber: row.returnNumber,
    status: row.status,
    productName: row.productName,
    quantity: toQty(row.quantity),
    created: row.created.toISOString(),
    customerNotes: row.customerNotes,
  };
}

/** The schema's ReturnReason values: the enum is the one list of reasons. */
const RETURN_REASONS: readonly string[] = Object.values(ReturnReason);

export function isReturnReason(value: unknown): value is ReturnReason {
  return typeof value === "string" && RETURN_REASONS.includes(value);
}

export interface PortalReturnRequest {
  portalToken: string;
  reason: ReturnReason;
  /** Stored as the return's customerNotes. */
  reasonNotes: string | null;
  /** The order line the return is for, when the customer names one. */
  lineItemId: number | null;
}

/**
 * The customer's return request body, checked. Each refusal says what the
 * caller got wrong, for a 400. Whether a named line may be the return's is the
 * database's question (returnLineProblem in returnLine.ts).
 */
export function parsePortalReturnRequest(
  body: unknown,
): { ok: true; value: PortalReturnRequest } | { ok: false; error: string } {
  const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const { portalToken, reason, reasonNotes, lineItemId } = input;

  if (!portalToken || typeof portalToken !== "string") {
    return { ok: false, error: "portalToken is required" };
  }
  if (!reason || typeof reason !== "string") {
    return { ok: false, error: "reason is required" };
  }
  if (!isReturnReason(reason)) {
    return { ok: false, error: `reason must be one of ${RETURN_REASONS.join(", ")}` };
  }
  if (reasonNotes != null && typeof reasonNotes !== "string") {
    return { ok: false, error: "reasonNotes must be text" };
  }
  if (lineItemId != null && !isLineItemId(lineItemId)) {
    return { ok: false, error: LINE_ITEM_ID_ERROR };
  }

  return {
    ok: true,
    value: {
      portalToken,
      reason,
      reasonNotes: (typeof reasonNotes === "string" && reasonNotes) || null,
      lineItemId: isLineItemId(lineItemId) ? lineItemId : null,
    },
  };
}
