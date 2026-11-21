// /app/__tests__/batchPrintRequest.test.ts
//
// What POST /api/print-label/batch reads from its body (lib/labels/batchPrintRequest.ts):
// the route's own rules and messages, tested without a printer or a database
// (rule 14). The route around it is in tags.integration.test.ts and
// scheduledSales.integration.test.ts.

import fc from "fast-check";
import { PRINT_BATCH_MAX_ITEMS } from "@/lib/labels/batchPrintShared";
import { readBatchPrintRequest, type BatchPrintEntry } from "@/lib/labels/batchPrintRequest";

const ITEMS_REQUIRED = { error: "items array is required" };
const COPIES_REFUSED = "copies must be a whole number from 1 to 10.";

/** The entries of a request that was accepted. */
function entriesOf(body: unknown): BatchPrintEntry[] {
  const read = readBatchPrintRequest(body);
  if ("error" in read) throw new Error(`refused: ${read.error}`);
  return read.entries;
}

describe("readBatchPrintRequest: the request", () => {
  it.each([
    ["no body (Next gives null)", null],
    ["a string body", "items"],
    ["no items", {}],
    ["empty items", { items: [] }],
    ["items that aren't an array", { items: { productId: 1 } }],
  ])("refuses %s: items are required", (_what, body) => {
    expect(readBatchPrintRequest(body)).toEqual(ITEMS_REQUIRED);
  });

  it(`takes ${PRINT_BATCH_MAX_ITEMS} items and refuses one more`, () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ productId: i + 1 }));
    expect(entriesOf({ items: items(PRINT_BATCH_MAX_ITEMS) })).toHaveLength(PRINT_BATCH_MAX_ITEMS);
    expect(readBatchPrintRequest({ items: items(PRINT_BATCH_MAX_ITEMS + 1) })).toEqual({
      error: `Batch size exceeds maximum of ${PRINT_BATCH_MAX_ITEMS} items`,
    });
  });

  it.each([
    [undefined, null],
    [null, null],
    ["PRODUCT", "PRODUCT"],
    ["SALE", "SALE"],
    ["LAW", "LAW"],
  ])("reads kind %p as %p", (kind, read) => {
    expect(readBatchPrintRequest({ items: [{ productId: 1 }], kind })).toMatchObject({
      kind: read,
    });
  });

  it.each(["CLEARANCE", "sale", 1])("refuses kind %p", (kind) => {
    expect(readBatchPrintRequest({ items: [{ productId: 1 }], kind })).toEqual({
      error: "kind must be PRODUCT, SALE or LAW.",
    });
  });

  it.each([
    ["absent", undefined, null],
    ["0", 0, null],
    ["empty", "", null],
    ["'7'", "7", 7],
    ["7", 7, 7],
    ["'abc'", "abc", Number.NaN],
    // The property below found this: Number() throws on it, which crashed the route.
    ["an object whose toString is null", JSON.parse('{"toString":null}'), Number.NaN],
  ])("reads storeLocationId given as %s (%p) as %p", (_what, storeLocationId, read) => {
    expect(readBatchPrintRequest({ items: [{ productId: 1 }], storeLocationId })).toMatchObject({
      storeLocationId: read,
    });
  });
});

describe("readBatchPrintRequest: each item", () => {
  it("fails an item with no productId, or one that isn't an object, on its own", () => {
    expect(entriesOf({ items: [{ copies: 2 }, null, { productId: 0 }] })).toEqual([
      { result: { productId: undefined, success: false, error: "productId is required" } },
      { result: { productId: undefined, success: false, error: "productId is required" } },
      { result: { productId: 0, success: false, error: "productId is required" } },
    ]);
  });

  it("asks for one copy when copies is left out, and takes up to ten", () => {
    expect(entriesOf({ items: [{ productId: 4 }, { productId: 5, copies: 10 }] })).toEqual([
      { job: { productId: 4, templateId: undefined, printerId: undefined, copies: 1 } },
      { job: { productId: 5, templateId: undefined, printerId: undefined, copies: 10 } },
    ]);
  });

  it.each([0, 11, 2.5, "3", null])("fails an item asking for %p copies, on its own", (copies) => {
    expect(entriesOf({ items: [{ productId: 9, copies }] })).toEqual([
      { result: { productId: 9, success: false, error: COPIES_REFUSED } },
    ]);
  });

  it("keeps the items' order, and a template and printer given with one", () => {
    const entries = entriesOf({
      items: [{ productId: 3, templateId: 8, printerId: 2, copies: 2 }, { productId: 1 }, null],
    });
    expect(entries.map((e) => ("job" in e ? e.job.productId : e.result.productId))).toEqual([
      3,
      1,
      undefined,
    ]);
    expect(entries[0]).toEqual({ job: { productId: 3, templateId: 8, printerId: 2, copies: 2 } });
  });

  it("never throws, and answers every item of an accepted request, in order", () => {
    const body = fc.oneof(
      fc.jsonValue(),
      fc.record(
        {
          items: fc.array(fc.jsonValue(), { minLength: 1, maxLength: PRINT_BATCH_MAX_ITEMS }),
          kind: fc.constantFrom(undefined, null, "PRODUCT", "SALE", "LAW"),
          storeLocationId: fc.jsonValue(),
        },
        { requiredKeys: ["items"] },
      ),
    );
    fc.assert(
      fc.property(body, (b) => {
        const read = readBatchPrintRequest(b);
        if ("error" in read) return;
        const items = (b as { items: unknown[] }).items;
        expect(read.entries).toHaveLength(items.length);
        for (const entry of read.entries) expect("job" in entry || "result" in entry).toBe(true);
      }),
    );
  });
});
