// /app/__tests__/parsePriceBook.test.ts
//
// The dispatcher behind /api/pricing/parse-pdf. Three things used to be silent
// -- an unknown vendor parsed as Wesley Hall, an unsupported book type parsed
// to nothing, and a zero-row result reported success. Each is now a distinct,
// named refusal. These tests never open a PDF: every refusal here happens
// before the buffer is read, and the zero-row rule is a pure function.

import {
  finalizeParse,
  isSupportedPriceBookVendor,
  LEGACY_VENDOR_IDS,
  parseIsRefused,
  parsePriceBook,
  supportedPriceBookVendorIds,
  UnsupportedTypeError,
  UnsupportedVendorError,
} from "@/lib/pricing/parsePriceBook";
import { supportedWholesaleVendorIds } from "@/lib/pricing/wholesale/registry";

const NOT_A_PDF = Buffer.from("not a pdf");

describe("the supported-vendor list", () => {
  it("is the registry plus the legacy readers, deduplicated and sorted", () => {
    const ids = supportedPriceBookVendorIds();
    for (const id of supportedWholesaleVendorIds()) expect(ids).toContain(id);
    for (const id of LEGACY_VENDOR_IDS) expect(ids).toContain(id);
    expect(ids).toEqual([...new Set(ids)].sort());
  });

  it("answers the same question the dispatcher asks", () => {
    expect(isSupportedPriceBookVendor("sam-moore")).toBe(true);
    expect(isSupportedPriceBookVendor("wesley-hall")).toBe(true);
    expect(isSupportedPriceBookVendor("century")).toBe(false);
    expect(isSupportedPriceBookVendor("")).toBe(false);
  });
});

describe("parsePriceBook refuses before it reads", () => {
  it("an unknown vendor is a named error carrying the supported list -- not a Wesley Hall parse", async () => {
    await expect(parsePriceBook(NOT_A_PDF, "century", "wholesale")).rejects.toBeInstanceOf(
      UnsupportedVendorError,
    );
    const err = await parsePriceBook(NOT_A_PDF, "century", "wholesale").catch((e) => e);
    expect(err.supported).toEqual(supportedPriceBookVendorIds());
    expect(err.message).toMatch(/No price-book reader for vendor "century"/);
  });

  it("a missing vendor is refused the same way -- there is no default any more", async () => {
    const err = await parsePriceBook(NOT_A_PDF, "", "wholesale").catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedVendorError);
    expect(err.message).toMatch(/A vendor is required/);
  });

  it("a registry vendor only reads its wholesale book", async () => {
    const err = await parsePriceBook(NOT_A_PDF, "sam-moore", "fabrics").catch((e) => e);
    expect(err).toBeInstanceOf(UnsupportedTypeError);
    expect(err.message).toMatch(/no reader for book type "fabrics"\. Accepted: wholesale/);
  });

  it("a legacy vendor with a type its reader lacks is refused, not parsed to nothing", async () => {
    const crl = await parsePriceBook(NOT_A_PDF, "cr-laine", "foundations").catch((e) => e);
    expect(crl).toBeInstanceOf(UnsupportedTypeError);
    expect(crl.message).toMatch(/Accepted: wholesale, simplicity/);

    const wh = await parsePriceBook(NOT_A_PDF, "wesley-hall", "casegoods").catch((e) => e);
    expect(wh).toBeInstanceOf(UnsupportedTypeError);
    expect(wh.message).toMatch(/Accepted: wholesale, foundations, fabrics, signature-elements/);
  });
});

describe("a zero always carries a reason", () => {
  const base = { vendor: "jensen-leisure", type: "wholesale", data: [], diagnostics: [] };

  it("finalizeParse attaches a generic error to a bare zero", () => {
    const out = finalizeParse({ ...base, count: 0 });
    expect(out.diagnostics).toEqual([
      expect.objectContaining({
        level: "error",
        message: expect.stringMatching(/jensen-leisure reader produced no rows/),
      }),
    ]);
    expect(parseIsRefused(out)).toBe(true);
  });

  it("finalizeParse leaves a zero that already explains itself alone", () => {
    const explained = {
      ...base,
      count: 0,
      diagnostics: [{ level: "error" as const, message: "0 grids on 12 pages" }],
    };
    expect(finalizeParse(explained)).toBe(explained);
  });

  it("finalizeParse never touches a parse with rows", () => {
    const withRows = { ...base, count: 3, data: [1, 2, 3] };
    expect(finalizeParse(withRows)).toBe(withRows);
    expect(parseIsRefused(withRows)).toBe(false);
  });

  it("rows plus an edition error is still a refusal -- the products are evidence, not a result", () => {
    const out = {
      ...base,
      count: 3,
      data: [1, 2, 3],
      diagnostics: [{ level: "error" as const, message: "expected >= 60 styles, got 3" }],
    };
    expect(parseIsRefused(out)).toBe(true);
  });

  it("warnings alone do not refuse", () => {
    const out = {
      ...base,
      count: 3,
      data: [1, 2, 3],
      diagnostics: [{ level: "warning" as const, message: "page 5: 1 style column dropped" }],
    };
    expect(parseIsRefused(out)).toBe(false);
  });
});
