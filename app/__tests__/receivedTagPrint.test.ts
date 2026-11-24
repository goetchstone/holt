// /app/__tests__/receivedTagPrint.test.ts
//
// The Receive PO screen's print of a receipt's tags, all at once after saving
// (lib/labels/receivedTagPrint.ts). The screen posted every tagged line in one
// request, and the batch route refuses more than PRINT_BATCH_MAX_ITEMS, so a
// receipt of more than 50 tagged lines printed no tags at all.
//
// The stand-in route reads each request with the batch route's own reader
// (readBatchPrintRequest), so it refuses what the route refuses, with the
// route's message.

import { PRINT_BATCH_MAX_ITEMS } from "@/lib/labels/batchPrintShared";
import { readBatchPrintRequest } from "@/lib/labels/batchPrintRequest";
import {
  printReceivedTags,
  receivedTagsReport,
  type ReceivedTagLine,
  type SendTagBatch,
  type TagPrintResult,
} from "@/lib/labels/receivedTagPrint";

/** The batch route as far as a request goes: its 400s, then each item printed or failed. */
function batchRoute(options: { refuse?: (request: number) => string | null } = {}) {
  const requests: { productId: number; copies: number }[][] = [];
  const send: SendTagBatch = async (items) => {
    requests.push(items);
    const refusal = options.refuse?.(requests.length) ?? null;
    if (refusal) throw new Error(refusal);
    const read = readBatchPrintRequest({ items, storeLocationId: 3 });
    if ("error" in read) throw new Error(read.error);
    return read.entries.map((entry): TagPrintResult =>
      "job" in entry ? { success: true } : { success: false, error: entry.result.error },
    );
  };
  return { send, requests };
}

const line = (n: number, quantity = 1): ReceivedTagLine => ({
  productId: n,
  quantity,
  name: `Product ${n}`,
});
const receipt = (count: number) => Array.from({ length: count }, (_, i) => line(i + 1));

describe("printReceivedTags", () => {
  it("prints a receipt of more than 50 tagged lines, in requests the route takes, in order", async () => {
    const lines = receipt(2 * PRINT_BATCH_MAX_ITEMS + 20);
    const { send, requests } = batchRoute();

    const batches = await printReceivedTags(lines, send);

    expect(batches).toEqual([
      { first: 1, last: 50, results: expect.any(Array), refused: null },
      { first: 51, last: 100, results: expect.any(Array), refused: null },
      { first: 101, last: 120, results: expect.any(Array), refused: null },
    ]);
    expect(requests.map((r) => r.length)).toEqual([50, 50, 20]);
    expect(requests.flat().map((item) => item.productId)).toEqual(lines.map((l) => l.productId));
    expect(batches.flatMap((b) => b.results ?? []).every((r) => r.success)).toBe(true);
    expect(receivedTagsReport(lines, batches)).toEqual({ errors: [], note: null });
  });

  it("asks for each line's receivedTagCopies: ten of a count past ten, one for a length", async () => {
    const { send, requests } = batchRoute();
    await printReceivedTags([line(1, 14), line(2, 12.5), line(3, 3)], send);
    expect(requests).toEqual([
      [
        { productId: 1, copies: 10 },
        { productId: 2, copies: 1 },
        { productId: 3, copies: 3 },
      ],
    ]);
  });

  it("stops at a refused request: the batches before it printed, the rest were not sent", async () => {
    const lines = receipt(120);
    const { send, requests } = batchRoute({
      refuse: (n) => (n === 2 ? "Too many requests, please try again later." : null),
    });

    const batches = await printReceivedTags(lines, send);

    expect(requests).toHaveLength(2);
    expect(batches).toEqual([
      { first: 1, last: 50, results: expect.any(Array), refused: null },
      {
        first: 51,
        last: 100,
        results: null,
        refused: "Too many requests, please try again later.",
      },
      { first: 101, last: 120, results: null, refused: null },
    ]);
    expect(receivedTagsReport(lines, batches).errors).toEqual([
      "The tags for Product 51 through Product 100 did not print: " +
        "Too many requests, please try again later.",
      "The tags for Product 101 through Product 120 were not sent.",
    ]);
  });
});

describe("receivedTagsReport", () => {
  it("names a failed line by its own name, wherever its batch fell", async () => {
    const lines = receipt(60);
    const failing: SendTagBatch = async (items) =>
      items.map((item) =>
        item.productId === 57
          ? { success: false, error: "No printer at Mill is loaded with its tag." }
          : { success: true },
      );

    const report = receivedTagsReport(lines, await printReceivedTags(lines, failing));

    expect(report.errors).toEqual([
      "Some tags failed: Product 57: No printer at Mill is loaded with its tag.",
    ]);
  });

  it("notes the lines left with pieces to tag among those that printed, in either batch", async () => {
    const lines = [...receipt(55), line(56, 14), line(57, 30)];
    const failing: SendTagBatch = async (items) =>
      items.map((item) =>
        item.productId === 57 ? { success: false, error: "Out of tags" } : { success: true },
      );

    const report = receivedTagsReport(lines, await printReceivedTags(lines, failing));

    expect(report.note).toBe(
      "Product 56: 10 tags printed, 4 still to print. " +
        "A print takes at most 10 of one tag, so print the rest from the product's page.",
    );
  });

  it("says only the route's own refusal for a receipt that took one request", async () => {
    const lines = receipt(7);
    const { send } = batchRoute({ refuse: () => "That store doesn't exist." });
    expect(receivedTagsReport(lines, await printReceivedTags(lines, send))).toEqual({
      errors: ["That store doesn't exist."],
      note: null,
    });
  });
});
