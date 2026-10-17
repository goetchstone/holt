// /app/__tests__/proposalPdf.test.ts
//
// A proposal line is quoted in yards when it is fabric, so its quantity can be
// a fraction. The item page's price line shows the whole line for any
// quantity but one -- half a yard is not priced as a yard.

import { itemPriceText } from "@/lib/proposalPdf";

describe("itemPriceText", () => {
  it("shows the unit price alone for one", () => {
    expect(itemPriceText(30, 1)).toBe("$30");
  });

  it("shows each x quantity = line for a part roll", () => {
    expect(itemPriceText(30, 12.5)).toBe("$30 each  x  12.5  =  $375");
  });

  it("shows each x quantity = line for less than one", () => {
    expect(itemPriceText(30, 0.5)).toBe("$30 each  x  0.5  =  $15");
  });
});
