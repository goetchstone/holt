// /app/src/lib/barcode.ts
//
// `prefix` is the business's AppSettings.barcodePrefix -- never a literal (it
// was one pilot's initials, hardcoded, before USE-12).
export function generateBarcode(
  prefix: string,
  vendorId: number | string,
  productId: number | string,
): string {
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${vendorId}-${productId}-${rand}`;
}
