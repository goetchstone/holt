// /app/__tests__/wholesaleCoverage.test.ts
//
// The price-book coverage manifest must stay honest about the code.
//
// This is the half that runs without the price books. They are private and
// never in CI; the other half (`node scripts/wholesale-coverage.mjs --dir
// <books>`) parses every book on the owner's machine against the same
// manifest. What CI can check is that the manifest and the readers cannot
// drift apart: a book may be marked parsed only where a reader exists, and may
// not stay "unsupported" once a reader accepts it -- adding a vendor profile
// turns this red until someone measures the book and records its count.

import { readFileSync } from "fs";
import { join } from "path";
import { supportedPriceBookVendorIds } from "@/lib/pricing/parsePriceBook";
import { judge, type Manifest } from "../scripts/wholesale-coverage.impl";

const manifest: Manifest = JSON.parse(
  readFileSync(join(__dirname, "../scripts/wholesale-coverage.expected.json"), "utf8"),
);
const supported = new Set(supportedPriceBookVendorIds());

describe("wholesale coverage manifest", () => {
  it("has well-formed, uniquely named entries", () => {
    const ids = manifest.books.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of manifest.books) {
      expect({
        id: b.id,
        dir: !!b.dir,
        match: !!b.match,
        vendor: !!b.vendor,
        type: !!b.type,
      }).toEqual({
        id: b.id,
        dir: true,
        match: true,
        vendor: true,
        type: true,
      });
    }
  });

  it("states a count for every parsed book and a reason for every other", () => {
    for (const b of manifest.books) {
      const e = b.expect;
      expect(e).toBeDefined();
      if (e!.status === "parsed") {
        expect([b.id, typeof e!.count === "number" && e!.count > 0]).toEqual([b.id, true]);
      } else {
        expect([b.id, e!.status, !!e!.reason?.trim()]).toEqual([b.id, e!.status, true]);
      }
    }
  });

  it("records counts only -- no field could carry a price", () => {
    for (const b of manifest.books) {
      for (const key of Object.keys(b.expect ?? {})) {
        expect([b.id, ["status", "count", "reason"].includes(key)]).toEqual([b.id, true]);
      }
    }
  });

  it("claims a parse or a refusal only where a reader exists", () => {
    for (const b of manifest.books.filter((x) => x.expect?.status !== "unsupported")) {
      expect([b.id, supported.has(b.vendor)]).toEqual([b.id, true]);
    }
  });

  it("marks a wholesale book unsupported only while no reader accepts it", () => {
    // A supported vendor's wholesale book is read or refused, never unsupported.
    // When a VAL package adds a reader, its books land here until measured.
    const stale = manifest.books
      .filter((b) => b.expect?.status === "unsupported")
      .filter((b) => supported.has(b.vendor) && b.type === "wholesale")
      .map((b) => b.id);
    expect(stale).toEqual([]);
  });
});

describe("judge", () => {
  const parsed100 = { status: "parsed" as const, count: 100 };

  it("accepts a parsed count within tolerance and rejects one outside it", () => {
    expect(judge({ status: "parsed", count: 109 }, parsed100, 0.1).verdict).toBe("ok");
    expect(judge({ status: "parsed", count: 89 }, parsed100, 0.1)).toEqual({
      verdict: "FAIL",
      why: "count 89 is outside 100 ±10%",
    });
  });

  it("fails a book whose status changed", () => {
    expect(judge({ status: "refused", count: 0 }, parsed100, 0.1).why).toBe(
      "expected parsed, got refused",
    );
  });

  it("fails an entry with no expectation, or a non-parse without a reason", () => {
    expect(judge({ status: "parsed", count: 5 }, undefined, 0.1).verdict).toBe("FAIL");
    expect(judge({ status: "unsupported", count: null }, { status: "unsupported" }, 0.1).why).toBe(
      'expected "unsupported" without a reason',
    );
  });

  it("accepts a known refusal that carries its reason", () => {
    expect(
      judge({ status: "refused", count: 0 }, { status: "refused", reason: "VAL-01" }, 0.1).verdict,
    ).toBe("ok");
  });
});
