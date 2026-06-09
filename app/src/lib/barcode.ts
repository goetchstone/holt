// /app/src/lib/barcode.ts
export function generateBarcode(vendorId: number | string, productId: number | string): string {
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `SH-${vendorId}-${productId}-${rand}`;
}
