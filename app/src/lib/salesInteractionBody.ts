// /app/src/lib/salesInteractionBody.ts
//
// Validates POST /api/sales/interactions. Logic lives here (not in the handler)
// so every branch is unit-tested. A nextFollowUpDate of undefined leaves the
// client's date alone; null clears it.

import { dayKeyToDbDate, isDayKey } from "@/lib/reports/businessDay";
import {
  INTERACTION_SOURCES,
  isInteractionSource,
  isNoteSource,
  type InteractionSource,
} from "@/lib/interactionSources";

export interface SalesInteractionInput {
  salesOrderId: number | null;
  customerId: number | null;
  source: InteractionSource;
  notes: string | null;
  nextFollowUpDate?: Date | null;
}

export type ParsedSalesInteraction =
  { ok: true; value: SalesInteractionInput } | { ok: false; error: string };

function readId(value: unknown): number | null | "invalid" {
  if (value === undefined || value === null) return null;
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : "invalid";
}

function readNextFollowUpDate(value: unknown): Date | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return isDayKey(value) ? dayKeyToDbDate(value) : "invalid";
}

export function parseSalesInteractionBody(body: unknown): ParsedSalesInteraction {
  const input = (body ?? {}) as Record<string, unknown>;

  if (!isInteractionSource(input.source)) {
    return { ok: false, error: `source must be one of: ${INTERACTION_SOURCES.join(", ")}` };
  }

  const salesOrderId = readId(input.salesOrderId);
  const customerId = readId(input.customerId);
  if (salesOrderId === "invalid" || customerId === "invalid") {
    return { ok: false, error: "salesOrderId and customerId must be positive whole numbers" };
  }

  const notes = typeof input.notes === "string" ? input.notes.trim() || null : null;
  if (isNoteSource(input.source)) {
    if (!notes) return { ok: false, error: "A note can't be empty." };
    if (!salesOrderId && !customerId) {
      return { ok: false, error: "A note needs a client or a quote." };
    }
  }

  const nextFollowUpDate = readNextFollowUpDate(input.nextFollowUpDate);
  if (nextFollowUpDate === "invalid") {
    return { ok: false, error: "nextFollowUpDate must be a date (YYYY-MM-DD) or null" };
  }

  return {
    ok: true,
    value: { salesOrderId, customerId, source: input.source, notes, nextFollowUpDate },
  };
}
