// /app/__tests__/scanCodes.test.ts
//
// Holt's own barcodes (lib/scan/scanCodes.ts): a place label L-<id> and a box
// label B-<product>-<box>-<of>. Anything else is text, looked up as scanned.

import { boxBarcode, cleanScan, parseScanCode, placeBarcode } from "@/lib/scan/scanCodes";

describe("parseScanCode", () => {
  it("reads place and box labels, any case, with the wedge's trailing CR or tab", () => {
    expect(parseScanCode("L-42\r")).toEqual({ kind: "place", placeId: 42 });
    expect(parseScanCode("l-42")).toEqual({ kind: "place", placeId: 42 });
    expect(parseScanCode("\tB-7-2-3\n")).toEqual({ kind: "box", productId: 7, box: 2, of: 3 });
  });

  it("round-trips what Holt prints", () => {
    expect(parseScanCode(placeBarcode(9))).toEqual({ kind: "place", placeId: 9 });
    expect(parseScanCode(boxBarcode(5, 1, 1))).toEqual({
      kind: "box",
      productId: 5,
      box: 1,
      of: 1,
    });
  });

  it("leaves everything else as text, including box numbers that cannot be", () => {
    expect(parseScanCode("012345678905")).toEqual({ kind: "text", text: "012345678905" });
    expect(parseScanCode("B-7-4-3")).toEqual({ kind: "text", text: "B-7-4-3" });
    expect(parseScanCode("B-7-0-3")).toEqual({ kind: "text", text: "B-7-0-3" });
    expect(parseScanCode("L-")).toEqual({ kind: "text", text: "L-" });
    expect(parseScanCode("SOFA-L-1")).toEqual({ kind: "text", text: "SOFA-L-1" });
  });

  it("cleans whitespace a scanner adds", () => {
    expect(cleanScan("  ABC-1 \r\n")).toBe("ABC-1");
  });
});
