// /app/src/lib/inventory/transfersShared.ts
//
// What the handheld's transfer screen and its routes agree on (rule 7).

/** A transfer on its way to a store, as the handheld's receipt lists it. */
export interface OnItsWay {
  id: number;
  productId: number;
  productNumber: string;
  name: string;
  boxesPerUnit: number;
  /** The store it was sent from. */
  from: string;
  remaining: number;
  /** The place it was sent to, when one was named. */
  toPlace: string | null;
  orderNo: string | null;
}
