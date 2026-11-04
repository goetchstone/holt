// /app/src/lib/sales/linePicture.ts
//
// GAP-07: the picture printed beside an order line on the invoice. The line's
// own product's picture first (a photo uploaded on the product, or the line
// drawing a price-list import extracted), then the picture of the vendor style
// it was configured from, on the line or on its product. A line with none
// prints none.

import type { Prisma } from "@prisma/client";

/** What linePictureUrl reads, as an include on an OrderLineItem query. */
export const LINE_PICTURE_INCLUDE = {
  product: { include: { vendorStyle: { select: { imageUrl: true } } } },
  vendorStyle: { select: { imageUrl: true } },
} satisfies Prisma.OrderLineItemInclude;

interface Picture {
  imageUrl: string | null;
}

export function linePictureUrl(line: {
  product?: (Picture & { vendorStyle?: Picture | null }) | null;
  vendorStyle?: Picture | null;
}): string | null {
  return (
    line.product?.imageUrl ||
    line.vendorStyle?.imageUrl ||
    line.product?.vendorStyle?.imageUrl ||
    null
  );
}
