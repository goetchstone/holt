// /app/src/app/(dashboard)/app/admin/buyer-drafts/itemFormState.ts
//
// Translates a fetched DraftItem into the wizard's ItemFormState shape (strings
// instead of Decimal-as-string, lifted FK ids). Pure adapter, behaviour
// verbatim from the legacy page.

import type { DraftItem } from "./types";

export function itemToFormState(item: DraftItem) {
  // If the item has any structured fields populated, default to "auto"
  // mode so the wizard shows them as inputs and previews. Otherwise fall
  // back to "manual" so the buyer's free-text isn't auto-overwritten.
  const hasStructured =
    item.itemType !== "OTHER" ||
    Boolean(item.grade) ||
    Boolean(item.fabric) ||
    Boolean(item.finish) ||
    Boolean(item.cushions) ||
    Boolean(item.cleaningCode) ||
    Boolean(item.tossPillows) ||
    Boolean(item.hardware) ||
    Boolean(item.hardwareFinish) ||
    Boolean(item.options);

  return {
    vendorId: item.vendorId,
    vendorName: item.vendorName,
    partNumber: item.partNumber,
    productName: item.productName,
    draftPoId: item.draftPoId,
    departmentId: item.department?.id ?? null,
    categoryId: item.category?.id ?? null,
    typeId: item.type?.id ?? null,
    itemType: item.itemType ?? "OTHER",
    grade: item.grade ?? "",
    fabric: item.fabric ?? "",
    finish: item.finish ?? "",
    cushions: item.cushions ?? "",
    cleaningCode: item.cleaningCode ?? "",
    tossPillows: item.tossPillows ?? "",
    hardware: item.hardware ?? "",
    hardwareFinish: item.hardwareFinish ?? "",
    options: item.options ?? "",
    description: item.description ?? "",
    descriptionMode: hasStructured ? ("auto" as const) : ("manual" as const),
    cost: item.cost,
    msrp: item.msrp ?? "",
    retail: item.retail,
    qty: String(item.qty),
    productWidth: item.productWidth ?? "",
    productLength: item.productLength ?? "",
    productHeight: item.productHeight ?? "",
    stockProgram: item.stockProgram,
    stockFamily: item.stockFamily ?? "",
    stockLocationId: item.stockLocationId,
    vignette: item.vignette ?? "",
    notes: item.notes ?? "",
    status: item.status === "DRAFT" || item.status === "READY" ? item.status : "DRAFT",
    // Slice 4-lite — preserve catalog linkage + source on edit
    vendorStyleId: null, // not in the listing payload; staying null on edit is safe
    source: item.source,
  };
}
