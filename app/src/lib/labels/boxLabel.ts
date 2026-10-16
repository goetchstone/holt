// /app/src/lib/labels/boxLabel.ts
//
// Box labels (ledger plan phase 16): "Box 2 of 3" for each box of each unit,
// with a barcode a handheld scans back to the product and the box,
// B-<productId>-<box>-<of> (lib/scan/scanCodes.ts). Boxes of the same product
// carry the same labels: a box is evidence of a unit, not a unit of its own.

import { boxNumbers } from "@/lib/inventory/boxes";
import { boxBarcode } from "@/lib/scan/scanCodes";
import { renderTemplate } from "./renderTemplate";

export function boxLabelFields(
  product: { id: number; name: string; productNumber: string; boxesPerUnit: number | null },
  box: number,
  poNumber: string | null,
) {
  const of = Math.max(1, product.boxesPerUnit ?? 1);
  return {
    name: product.name,
    sku: product.productNumber,
    box,
    of,
    poNumber: poNumber ?? "",
    barcode: boxBarcode(product.id, box, of),
  };
}

/** Every box of `units` units, in box order per unit. */
export function renderBoxLabels(
  zplTemplate: string,
  product: { id: number; name: string; productNumber: string; boxesPerUnit: number | null },
  units: number,
  poNumber: string | null,
): string {
  const out: string[] = [];
  for (let u = 0; u < units; u++) {
    for (const b of boxNumbers(product.boxesPerUnit ?? 1)) {
      out.push(renderTemplate(zplTemplate, boxLabelFields(product, b, poNumber)));
    }
  }
  return out.join("");
}
