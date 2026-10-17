// /app/src/lib/scan/scanCodes.ts
//
// The barcodes Holt prints for itself, and nothing else (pure, so the
// handheld pages and the server read them the same way):
//
//   L-<placeId>                    a place's label (Warehouse > Locations)
//   B-<productId>-<box>-<of>       one box of a multi-box unit ("Box 2 of 3")
//
// Everything else a scanner sends -- a UPC, a consignment rug's barcode, a
// product number, a place's own code -- is looked up as it is, never parsed
// (lib/scan/resolveScan.ts).

export type ScanCode =
  | { kind: "place"; placeId: number }
  | { kind: "box"; productId: number; box: number; of: number }
  | { kind: "text"; text: string };

const PLACE = /^L-(\d{1,9})$/i;
const BOX = /^B-(\d{1,9})-(\d{1,3})-(\d{1,3})$/i;

/** A scanner's text, trimmed (wedges often send a trailing CR or tab). */
export function cleanScan(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, "").trim();
}

export function parseScanCode(raw: string): ScanCode {
  const text = cleanScan(raw);
  const place = PLACE.exec(text);
  if (place) return { kind: "place", placeId: Number(place[1]) };
  const box = BOX.exec(text);
  if (box) {
    const b = Number(box[2]);
    const of = Number(box[3]);
    if (b >= 1 && of >= 1 && b <= of) return { kind: "box", productId: Number(box[1]), box: b, of };
  }
  return { kind: "text", text };
}

export const placeBarcode = (placeId: number) => `L-${placeId}`;

export const boxBarcode = (productId: number, box: number, of: number) =>
  `B-${productId}-${box}-${of}`;
