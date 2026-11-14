// /app/__tests__/bulkSalespersonShared.test.ts
//
// Salesperson Corrections names each order a bulk update refused, and why.
// Its toast once read "Updated 17 order(s). 3 failed." and dropped the
// route's errors, so a manager whose orders already split with the new
// salesperson could not tell which three, or what to change.

import {
  bulkSalespersonFailures,
  bulkSalespersonSummary,
  KEPT_SPLIT_IS_NEW_SALESPERSON,
} from "@/lib/sales/bulkSalespersonShared";

describe("bulk salesperson result on the corrections screen", () => {
  const orders = [
    { id: 1, orderno: "TST-1001" },
    { id: 2, orderno: "TST-1002" },
  ];

  it("lists each refused order by its number with the route's reason", () => {
    expect(
      bulkSalespersonFailures(
        [
          { orderId: 2, reason: KEPT_SPLIT_IS_NEW_SALESPERSON },
          { orderId: 9, reason: "Order not found" },
        ],
        orders,
      ),
    ).toEqual([
      { orderId: 2, orderno: "TST-1002", reason: KEPT_SPLIT_IS_NEW_SALESPERSON },
      { orderId: 9, orderno: "Order #9", reason: "Order not found" },
    ]);
  });

  it("warns, rather than reporting success, when some orders were refused", () => {
    expect(bulkSalespersonSummary({ updated: 17, errors: [{ orderId: 2, reason: "x" }] })).toEqual({
      level: "warning",
      message: "Updated 17 order(s). 1 order(s) were not changed; the list below says why.",
    });
  });

  it("reports an error when every order was refused", () => {
    expect(
      bulkSalespersonSummary({ updated: 0, errors: [{ orderId: 2, reason: "x" }] }).level,
    ).toBe("error");
  });

  it("reports success or no change when nothing was refused", () => {
    expect(bulkSalespersonSummary({ updated: 3, errors: [] })).toEqual({
      level: "success",
      message: "Updated 3 order(s).",
    });
    expect(bulkSalespersonSummary({ updated: 0, errors: [] }).level).toBe("info");
  });
});
