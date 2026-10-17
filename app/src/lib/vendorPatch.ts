// /app/src/lib/vendorPatch.ts
//
// What PATCH /api/vendors/:id may change, read from the request body.
//
// The route was written for the pricing configurator and accepted only its four
// pricing fields. The vendor screen's edit modal sends the whole vendor --
// address, phone, email -- to the same route, which ignored all of it and still
// answered 200: an edited address was "saved" and nothing changed. The vendor's
// contact details and its lead time are accepted here too, so the modal saves
// what it shows. Anything else in the body (id, timestamps, relations) is
// ignored.
//
// The NAME stays out, as the 2026-06-10 security sweep left it. Importers find a
// vendor by its name, so a rename here would make the next import create a
// second vendor beside the renamed one.

import type { Prisma } from "@prisma/client";
import { parseLeadTimeDays } from "@/lib/vendorLeadTime";

/** Plain-text contact details the edit modal can change. */
export const VENDOR_DETAIL_FIELDS = ["address", "city", "state", "zip", "phone", "email"] as const;

export type VendorPatchParse =
  { ok: true; data: Prisma.VendorUpdateInput } | { ok: false; error: string };

export function parseVendorPatch(body: Record<string, unknown>): VendorPatchParse {
  const data: Prisma.VendorUpdateInput = {};

  // Pricing defaults, exactly as before: the configurator sends numbers or null.
  if (body.defaultMarkup !== undefined) {
    data.defaultMarkup = body.defaultMarkup as Prisma.VendorUpdateInput["defaultMarkup"];
  }
  if (body.defaultDiscount !== undefined) {
    data.defaultDiscount = body.defaultDiscount as Prisma.VendorUpdateInput["defaultDiscount"];
  }
  if (typeof body.mapEnforced === "boolean") data.mapEnforced = body.mapEnforced;
  if (typeof body.allowTradeDiscount === "boolean") {
    data.allowTradeDiscount = body.allowTradeDiscount;
  }

  for (const field of VENDOR_DETAIL_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw !== null && typeof raw !== "string") {
      return { ok: false, error: `${field} must be text` };
    }
    data[field] = raw?.trim() || null;
  }

  if ("leadTimeDays" in body) {
    const lead = parseLeadTimeDays(body.leadTimeDays);
    if (!lead.ok) return { ok: false, error: lead.error };
    data.leadTimeDays = lead.value;
  }

  if (Object.keys(data).length === 0) {
    return { ok: false, error: "No updatable fields in request" };
  }
  return { ok: true, data };
}
