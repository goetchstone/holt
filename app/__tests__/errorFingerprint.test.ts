// /app/__tests__/errorFingerprint.test.ts
//
// Fingerprinting is the single decision that makes the ErrorEvent table useful
// or useless, so it gets tested from both directions: things that must MERGE
// (or a crash loop writes 5,000 rows during the incident you need the table
// for) and things that must STAY DISTINCT (or unrelated bugs hide inside one
// row with a misleading sample).

import {
  fingerprintError,
  normalizeErrorMessage,
  topAppFrame,
} from "@/lib/errorFingerprint";

const fp = (msg: string, stack?: string) => fingerprintError(msg, stack).fingerprint;

describe("normalizeErrorMessage", () => {
  it("strips ids, so the same bug on different records is one bug", () => {
    expect(normalizeErrorMessage("Order 123 not found")).toBe(
      normalizeErrorMessage("Order 456789 not found"),
    );
  });

  it("strips uuids, quoted values, emails and urls", () => {
    expect(normalizeErrorMessage("session 3f2504e0-4f89-11d3-9a0c-0305e82c3301 expired")).toBe(
      "session <uuid> expired",
    );
    expect(normalizeErrorMessage(`Vendor 'Wesley Hall' missing`)).toBe("Vendor '<v>' missing");
    expect(normalizeErrorMessage("mail to bob@example.com failed")).toBe("mail to <email> failed");
    expect(normalizeErrorMessage("GET https://api.stripe.com/v1/x 500")).toBe("GET <url> <n>");
  });

  it("strips timestamps before numbers, so a date is not a pile of digits", () => {
    expect(normalizeErrorMessage("at 2026-08-05T17:00:00Z sync failed")).toBe(
      "at <ts> sync failed",
    );
    expect(normalizeErrorMessage("for 2026-08-05 nothing ran")).toBe("for <date> nothing ran");
  });

  it("collapses whitespace so reformatting does not split a fingerprint", () => {
    expect(normalizeErrorMessage("a   b\n c")).toBe("a b c");
  });

  it("keeps the words that identify the failure", () => {
    // The point is not to erase the message -- an operator still has to read it.
    expect(normalizeErrorMessage("Payment 99 declined by processor")).toBe(
      "Payment <n> declined by processor",
    );
  });
});

describe("topAppFrame", () => {
  it("skips node_modules and node internals to find our frame", () => {
    // An error thrown inside Prisma is identified by OUR call site; otherwise
    // every database error in the app shares one fingerprint.
    const stack = [
      "Error: connect ECONNREFUSED",
      "    at PrismaClient._request (/app/node_modules/@prisma/client/index.js:123:45)",
      "    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "    at computeBalance (/app/src/lib/paymentService.ts:61:20)",
    ].join("\n");
    expect(topAppFrame(stack)).toContain("computeBalance");
    expect(topAppFrame(stack)).not.toContain("node_modules");
  });

  it("drops absolute paths and line numbers", () => {
    // Otherwise editing a line ABOVE the throw site invents a new bug, and
    // every deploy with a different build path fragments the history.
    const a = topAppFrame("Error: x\n    at foo (/build/abc/src/lib/y.ts:10:3)");
    const b = topAppFrame("Error: x\n    at foo (/build/xyz/src/lib/y.ts:99:7)");
    expect(a).toBe(b);
  });

  it("returns null when there is no usable frame", () => {
    expect(topAppFrame(undefined)).toBeNull();
    expect(topAppFrame("Error: x\n    at f (/app/node_modules/z/i.js:1:1)")).toBeNull();
  });
});

describe("fingerprintError", () => {
  it("MERGES the same failure on different records", () => {
    expect(fp("Order 123 not found")).toBe(fp("Order 456 not found"));
  });

  it("KEEPS DISTINCT two different failures", () => {
    expect(fp("Order 123 not found")).not.toBe(fp("Customer 123 not found"));
  });

  it("KEEPS DISTINCT the same generic message from different call sites", () => {
    // "Not found" thrown from two places is two bugs. Without the stack frame
    // they would merge and the sample would point at whichever fired last.
    const a = fp("Not found", "Error: Not found\n    at a (/app/src/lib/a.ts:1:1)");
    const b = fp("Not found", "Error: Not found\n    at b (/app/src/lib/b.ts:1:1)");
    expect(a).not.toBe(b);
  });

  it("is stable across occurrences of one bug with different ids AND line numbers", () => {
    const a = fp("Order 1 failed", "Error\n    at handler (/app/src/pages/api/x.ts:10:5)");
    const b = fp("Order 2 failed", "Error\n    at handler (/app/src/pages/api/x.ts:11:9)");
    expect(a).toBe(b);
  });

  it("separates by scope when one is given", () => {
    expect(fp("boom")).not.toBe(fingerprintError("boom", undefined, { scope: "trpc" }).fingerprint);
  });

  it("produces a short, index-friendly key", () => {
    expect(fp("anything")).toMatch(/^[0-9a-f]{32}$/);
  });
});
