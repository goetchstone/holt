// /app/__tests__/deliveredLines.test.ts
//
// The driver's delivered counts (lib/fulfilment/deliveredLines.ts): only open
// product lines are goods to count, a count is held to what is still to go,
// and anything short of that is a part delivery.

import { deliveredPayload, isPartDelivery, openStopLines } from "@/lib/fulfilment/deliveredLines";

const lines = [
  { id: 1, productId: 10, productName: "Lamp", orderedQuantity: "2", fulfilledQty: "1" },
  { id: 2, productId: 11, productName: "Sofa", orderedQuantity: 1, fulfilledQty: null },
  { id: 3, productId: null, productName: "Delivery fee", orderedQuantity: 1 },
  { id: 4, productId: 12, productName: "Rug", orderedQuantity: 1, lineItemStatus: "CANCELLED" },
  { id: 5, productId: 13, productName: "Chair", orderedQuantity: 1, fulfilledQty: 1 },
  { id: 6, productId: 14, productName: null, orderedQuantity: 2.5, fulfilledQty: 0 },
];

describe("delivered counts", () => {
  it("counts only open product lines, and what is still to go on each", () => {
    expect(openStopLines(lines)).toEqual([
      { id: 1, name: "Lamp", open: 1 },
      { id: 2, name: "Sofa", open: 1 },
      { id: 6, name: "Unnamed item", open: 2.5 },
    ]);
  });

  it("sends every open line, all of it unless the driver said less", () => {
    const open = openStopLines(lines);
    expect(deliveredPayload(open, {})).toEqual([
      { orderLineItemId: 1, quantity: 1 },
      { orderLineItemId: 2, quantity: 1 },
      { orderLineItemId: 6, quantity: 2.5 },
    ]);
    expect(isPartDelivery(open, {})).toBe(false);
  });

  it("holds a count to 0..open and calls anything short a part delivery", () => {
    const open = openStopLines(lines);
    const counts = { 1: 5, 2: -1, 6: 2 };
    expect(deliveredPayload(open, counts)).toEqual([
      { orderLineItemId: 1, quantity: 1 },
      { orderLineItemId: 2, quantity: 0 },
      { orderLineItemId: 6, quantity: 2 },
    ]);
    expect(isPartDelivery(open, counts)).toBe(true);
  });
});
