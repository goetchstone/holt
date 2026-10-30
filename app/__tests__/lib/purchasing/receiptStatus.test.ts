// /app/__tests__/lib/purchasing/receiptStatus.test.ts
//
// A PO's status from what its lines ordered and received: after a receipt, and
// after a receipt is taken back (GAP-02).

import { correctedReceiptStatus, nativeReceiptStatus } from "@/lib/purchasing/receiptStatus";

describe("nativeReceiptStatus", () => {
  it("reads full, partial, or as it was", () => {
    expect(nativeReceiptStatus([{ ordered: 2, received: 2 }], "CONFIRMED")).toBe("RECEIVED_FULL");
    expect(nativeReceiptStatus([{ ordered: 2, received: 1 }], "CONFIRMED")).toBe(
      "RECEIVED_PARTIAL",
    );
    expect(nativeReceiptStatus([{ ordered: 2, received: 0 }], "CONFIRMED")).toBe("CONFIRMED");
  });

  it("leaves a cancelled (zero-quantity) line out of both sides (rule 39)", () => {
    expect(
      nativeReceiptStatus(
        [
          { ordered: 2, received: 2 },
          { ordered: 0, received: 0 },
        ],
        "CONFIRMED",
      ),
    ).toBe("RECEIVED_FULL");
  });
});

describe("correctedReceiptStatus", () => {
  it("reads full or partial from what is still received", () => {
    expect(correctedReceiptStatus([{ ordered: 4, received: 4 }], "RECEIVED_FULL")).toBe(
      "RECEIVED_FULL",
    );
    expect(correctedReceiptStatus([{ ordered: 4, received: 3 }], "RECEIVED_FULL")).toBe(
      "RECEIVED_PARTIAL",
    );
  });

  it("puts a PO with nothing received any more back to Confirmed", () => {
    expect(correctedReceiptStatus([{ ordered: 4, received: 0 }], "RECEIVED_PARTIAL")).toBe(
      "CONFIRMED",
    );
    expect(correctedReceiptStatus([{ ordered: 4, received: 0 }], "RECEIVED_FULL")).toBe(
      "CONFIRMED",
    );
  });

  it("leaves a short-closed or cancelled PO as someone set it", () => {
    expect(correctedReceiptStatus([{ ordered: 4, received: 1 }], "SHORT_CLOSED")).toBe(
      "SHORT_CLOSED",
    );
    expect(correctedReceiptStatus([{ ordered: 4, received: 0 }], "CANCELLED")).toBe("CANCELLED");
  });
});
