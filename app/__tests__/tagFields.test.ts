// /app/__tests__/tagFields.test.ts
//
// The pure parts of GAP-18: the cost code, a picture as ZPL, the sale tag's
// figures, who gets a sold tag, and how someone's print mode reads back.

import { cipherKeyProblem, costCode, normalizeCipherKey } from "@/lib/labels/costCode";
import {
  ditherToDots,
  graphicField,
  localPicturePath,
  photoDotsProblem,
  PHOTO_DOTS_MAX,
} from "@/lib/labels/photo";
import { isProductTagKind, saleFields } from "@/lib/labels/productTag";
import {
  isLabelContext,
  LABEL_CONTEXT_NAMES,
  LABEL_FIELDS,
  renderTemplate,
  ZplGraphic,
} from "@/lib/labels/renderTemplate";
import { soldTagFields, soldTagProblem, type SoldTagLine } from "@/lib/labels/soldTag";
import { readTagPrintMode } from "@/lib/labels/tagPrintMode";
import { UPLOAD_ROOT } from "@/lib/secureUpload";
import path from "node:path";

const KEY = "MARBLECOUT";

describe("costCode", () => {
  it("reads 1 to 9 from the first nine letters and 0 from the tenth", () => {
    expect(costCode(1234567890, KEY)).toBe("MARBLECOUT");
  });

  it("codes a cost as the store would read it", () => {
    expect(costCode(1250, KEY)).toBe("MALT");
    expect(costCode(100, KEY)).toBe("MTT");
    expect(costCode(0, KEY)).toBe("T");
  });

  it("rounds to whole dollars", () => {
    expect(costCode(99.5, KEY)).toBe("MTT");
    expect(costCode(99.4, KEY)).toBe("UU");
  });

  it("is blank with no key or no cost, never the real number", () => {
    expect(costCode(1250, null)).toBe("");
    expect(costCode(1250, "")).toBe("");
    expect(costCode(null, KEY)).toBe("");
    expect(costCode(Number.NaN, KEY)).toBe("");
    expect(costCode(-5, KEY)).toBe("");
  });
});

describe("cipherKeyProblem", () => {
  it("takes ten different capitals", () => {
    expect(cipherKeyProblem(KEY)).toBeNull();
  });

  it.each(["MARBLE", "MARBLECOUTS", "MARBLECOU1", "marblecout", ""])("refuses %p", (key) => {
    expect(cipherKeyProblem(key)).toMatch(/exactly 10 letters/);
  });

  it("refuses a repeated letter, which would read two digits the same", () => {
    expect(cipherKeyProblem("MARBLECOUM")).toMatch(/only be used once/);
  });

  it("reads what a person typed as capitals, without spaces around it", () => {
    expect(normalizeCipherKey("  marblecout ")).toBe(KEY);
  });
});

describe("the picture as ZPL", () => {
  it("packs a row into bytes with a set bit printing, padding to a whole byte", () => {
    const row = [true, false, false, false, false, false, false, true, true, false];
    expect(graphicField(row, 10, 1)).toBe("^GFA,2,2,2,8180");
  });

  it("counts every row in its totals", () => {
    const dots = new Array(16 * 3).fill(false);
    dots[0] = true;
    dots[47] = true;
    expect(graphicField(dots, 16, 3)).toBe("^GFA,6,6,2,800000000001");
  });

  it("prints black and leaves white", () => {
    expect(ditherToDots(new Uint8Array([0, 0, 0, 0]), 2, 2)).toEqual([true, true, true, true]);
    expect(ditherToDots(new Uint8Array([255, 255, 255, 255]), 2, 2)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it("dithers grey into about half its dots, not a solid block", () => {
    const size = 40;
    const dots = ditherToDots(new Uint8Array(size * size).fill(128), size, size);
    const inked = dots.filter(Boolean).length / dots.length;
    expect(inked).toBeGreaterThan(0.4);
    expect(inked).toBeLessThan(0.6);
  });

  it("passes rounding error on, so a dark grey prints darker than a light one", () => {
    const size = 40;
    const ink = (level: number) =>
      ditherToDots(new Uint8Array(size * size).fill(level), size, size).filter(Boolean).length;
    expect(ink(64)).toBeGreaterThan(ink(192));
  });

  it("passes a pixel's error to the right and down", () => {
    expect(ditherToDots(new Uint8Array([100, 100]), 2, 1)).toEqual([true, false]);
    expect(ditherToDots(new Uint8Array([100, 100]), 1, 2)).toEqual([true, false]);
  });

  it("doesn't pass error around a row's edge onto another row", () => {
    // Each pixel sits just above the line, where a little error from the far edge
    // of the row before, or from the start of its own row, would tip it into ink.
    const rightward = ditherToDots(new Uint8Array([255, 255, 255, 200, 140, 255, 255, 255]), 4, 2);
    expect(rightward[4]).toBe(false);
    const downLeft = ditherToDots(new Uint8Array([200, 255, 255, 135]), 4, 1);
    expect(downLeft[3]).toBe(false);
    const downRight = ditherToDots(new Uint8Array([255, 200, 255, 255, 136, 255]), 2, 3);
    expect(downRight[4]).toBe(false);
  });

  it("reads only a picture Holt holds, from under the upload folder", () => {
    expect(localPicturePath("/uploads/images/products/a.png")).toBe(
      path.join(UPLOAD_ROOT, "images/products/a.png"),
    );
    expect(localPicturePath("https://example.com/a.png")).toBeNull();
    expect(localPicturePath("/uploads/../../etc/passwd")).toBeNull();
    expect(localPicturePath("/etc/passwd")).toBeNull();
    expect(localPicturePath("/uploads/")).toBeNull();
  });

  it("takes a whole size in range, or none", () => {
    expect(photoDotsProblem(null)).toBeNull();
    expect(photoDotsProblem(undefined)).toBeNull();
    expect(photoDotsProblem(1)).toBeNull();
    expect(photoDotsProblem(PHOTO_DOTS_MAX)).toBeNull();
    for (const bad of [0, -1, 1.5, PHOTO_DOTS_MAX + 1, "200"]) {
      expect(photoDotsProblem(bad)).toMatch(/whole number of dots/);
    }
  });
});

describe("renderTemplate and a graphic", () => {
  it("puts code-built ZPL on the label as it is, under double or triple braces", () => {
    const photo = new ZplGraphic("^GFA,1,1,1,80");
    expect(renderTemplate("^FO1,1{{photo}}^FS", { photo })).toBe("^FO1,1^GFA,1,1,1,80^FS");
    expect(renderTemplate("^FO1,1{{{photo}}}^FS", { photo })).toBe("^FO1,1^GFA,1,1,1,80^FS");
  });

  it("still keeps a record's text from being read as commands", () => {
    expect(renderTemplate("^FD{{name}}^FS", { name: "50^ off ~JA" })).toBe("^FD50  off  JA^FS");
    expect(renderTemplate("^FD{{lawText}}^FS", { lawText: "^XZ~JR" })).toBe("^FD XZ JR^FS");
  });

  it("names every kind of label for the template screen", () => {
    expect(Object.keys(LABEL_CONTEXT_NAMES).sort()).toEqual(Object.keys(LABEL_FIELDS).sort());
    for (const context of Object.keys(LABEL_FIELDS)) expect(isLabelContext(context)).toBe(true);
  });

  it("offers a coded cost wherever it offers the real one", () => {
    for (const fields of Object.values(LABEL_FIELDS)) {
      const list = fields as readonly string[];
      if (list.includes("baseCost")) expect(list).toContain("costCode");
    }
  });

  it("gives a sold tag no cost or price, and a law tag none either", () => {
    for (const context of ["SOLD", "LAW"] as const) {
      const fields = LABEL_FIELDS[context] as readonly string[];
      expect(fields.filter((f) => /cost|retail|price/i.test(f))).toEqual([]);
    }
  });
});

describe("saleFields", () => {
  it("works out the saving from what the register charges", () => {
    expect(saleFields(2000, 1500)).toEqual({
      wasPrice: "2000.00",
      saving: "500.00",
      savingPercent: "25",
    });
  });

  it("rounds the percent to a whole number", () => {
    expect(saleFields(300, 200)).toMatchObject({ savingPercent: "33" });
  });

  it("refuses a tag with no was price, or no retail", () => {
    expect(saleFields(null, 100)).toEqual({
      problem: expect.stringMatching(/^Set this product's was/),
    });
    expect(saleFields(100, null)).toEqual({ problem: expect.stringMatching(/retail price/) });
    expect(saleFields(100, 0)).toEqual({ problem: expect.stringMatching(/retail price/) });
  });

  it("refuses a was price that isn't above retail: that's not a saving", () => {
    expect(saleFields(100, 100)).toEqual({ problem: expect.stringMatching(/must be above/) });
    expect(saleFields(90, 100)).toEqual({ problem: expect.stringMatching(/must be above/) });
  });
});

describe("isProductTagKind", () => {
  it("takes a product's own kinds, and not a place's or an order's", () => {
    for (const kind of ["PRODUCT", "SALE", "LAW"]) expect(isProductTagKind(kind)).toBe(true);
    for (const kind of ["SOLD", "BOX", "LOCATION", "", null, 1]) {
      expect(isProductTagKind(kind)).toBe(false);
    }
  });
});

describe("soldTagProblem", () => {
  const line = (over: Partial<SoldTagLine> = {}): SoldTagLine => ({
    lineItemStatus: "ACTIVE",
    orderedQuantity: 1,
    productName: "Sofa",
    product: null,
    ...over,
  });

  it("takes a line of an order or a fulfilled order", () => {
    expect(soldTagProblem("ORDER", line())).toBeNull();
    expect(soldTagProblem("FULFILLED", line())).toBeNull();
  });

  it.each(["QUOTE", "CANCELLED", "RETURNED"])("refuses a %s", (status) => {
    expect(soldTagProblem(status, line())).toMatch(/sold order/);
  });

  it.each(["CANCELLED", "REPLACED"])("refuses a %s line", (lineItemStatus) => {
    expect(soldTagProblem("ORDER", line({ lineItemStatus }))).toMatch(/no longer on the order/);
  });

  it("refuses a zero-quantity line (rule 31)", () => {
    expect(soldTagProblem("ORDER", line({ orderedQuantity: 0 }))).toMatch(/nothing on it/);
  });

  it("refuses a gift card line, which isn't a piece to tag", () => {
    expect(soldTagProblem("ORDER", line({ giftCardNumber: "GC-1001", product: null }))).toMatch(
      /gift card/,
    );
    expect(soldTagProblem("ORDER", line({ giftCardNumber: null }))).toBeNull();
  });
});

describe("soldTagFields", () => {
  const order = {
    orderno: "SO-9",
    status: "ORDER",
    orderDate: new Date("2026-08-09T00:30:00.000Z"),
    customer: { firstName: "Ada", lastName: "Ames" },
    salesPerson: { displayName: "Sam" },
  };
  const line = {
    lineItemStatus: "ACTIVE",
    orderedQuantity: 2,
    productName: "As sold",
    product: { name: "Sofa", productNumber: "S-1", vendor: { name: "Heron" } },
  };

  it("fills every field the catalog lists", () => {
    const fields = soldTagFields(order, line, "America/New_York");
    expect(Object.keys(fields).sort()).toEqual([...LABEL_FIELDS.SOLD].sort());
  });

  it("dates it by the store's day, and names the customer both ways", () => {
    expect(soldTagFields(order, line, "America/New_York")).toMatchObject({
      soldOn: "2026-08-08",
      customer: "Ada Ames",
      customerLastName: "Ames",
      orderNumber: "SO-9",
      salesperson: "Sam",
      quantity: 2,
    });
  });

  it("uses the line's own name when it has no product", () => {
    const fields = soldTagFields(order, { ...line, product: null }, "UTC");
    expect(fields).toMatchObject({ name: "As sold", sku: "", vendor: "" });
  });

  it("copes with no customer, date or salesperson", () => {
    const bare = { ...order, customer: null, orderDate: null, salesPerson: null };
    expect(soldTagFields(bare, line, "UTC")).toMatchObject({
      customer: "",
      customerLastName: "",
      soldOn: "",
      salesperson: "",
    });
  });
});

describe("readTagPrintMode", () => {
  it("is one at a time for someone who hasn't chosen", () => {
    expect(readTagPrintMode(null)).toBe("ONE_AT_A_TIME");
    expect(readTagPrintMode(undefined)).toBe("ONE_AT_A_TIME");
  });

  it("remembers a choice", () => {
    expect(readTagPrintMode("BATCH")).toBe("BATCH");
    expect(readTagPrintMode("ONE_AT_A_TIME")).toBe("ONE_AT_A_TIME");
  });
});
