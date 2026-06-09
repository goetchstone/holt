// /app/__tests__/serviceCaseSheetImport.test.ts
//
// Pure-helper coverage for the Customer Service Sheet parsers + mappers.
// No DB, no I/O — exercises the parts of the importer that need to be
// rock-solid before any real .xlsx gets fed through it.

import {
  parsePersonXml,
  parseThreadedCommentXml,
  parseThreadedCommentDate,
  mapExcelStatusName,
  extractSalesOrderTokens,
  extractPoTokens,
  poNumberCandidates,
  normalizePhone,
  resolveAuthor,
  computeRowKey,
  coerceDate,
  anchorDateOnlyToLocalNoon,
  generateImportedCaseNumber,
} from "../src/lib/serviceCaseSheetImport";

describe("parsePersonXml", () => {
  it("extracts displayName + userId for every <x18tc:person>", () => {
    const xml = `<?xml version="1.0"?><x18tc:personList xmlns:x18tc="http://example">
      <x18tc:person displayName="Rebecca Warren" id="{aaaaaaa1-bbbb-cccc-dddd-eeeeeeeeeeee}" providerId="google-sheets"/>
      <x18tc:person displayName="rwarren@example.com" id="{fffffff2-aaaa-bbbb-cccc-dddddddddddd}" userId="rwarren@example.com" providerId="google-sheets"/>
    </x18tc:personList>`;
    const map = parsePersonXml(xml);
    expect(map.size).toBe(2);
    expect(map.get("aaaaaaa1-bbbb-cccc-dddd-eeeeeeeeeeee")?.displayName).toBe("Rebecca Warren");
    expect(map.get("fffffff2-aaaa-bbbb-cccc-dddddddddddd")?.userId).toBe("rwarren@example.com");
  });

  it("tolerates attribute orderings in either direction", () => {
    // userId before displayName — real-world Example .xlsx has this.
    const xml = `<x18tc:personList xmlns:x18tc="x">
      <x18tc:person id="{zzzzzzz1-1111-1111-1111-111111111111}" userId="alex@example.com" displayName="Alex"/>
    </x18tc:personList>`;
    const map = parsePersonXml(xml);
    expect(map.size).toBe(1);
    expect(map.get("zzzzzzz1-1111-1111-1111-111111111111")?.displayName).toBe("Alex");
  });
});

describe("parseThreadedCommentXml", () => {
  it("extracts every threaded comment with ref + author + dT + text + parentId", () => {
    const xml = `<?xml version="1.0"?><x18tc:ThreadedComments xmlns:x18tc="x">
      <x18tc:threadedComment ref="K3" dT="2025-12-03T19:19:55.00" personId="{p1}" id="{c1}" done="0">
        <x18tc:text xml:space="preserve">Initial issue text</x18tc:text>
      </x18tc:threadedComment>
      <x18tc:threadedComment ref="K3" dT="2025-12-09T20:17:12.00" personId="{p2}" id="{c2}" parentId="{c1}">
        <x18tc:text xml:space="preserve">Reply with &amp; ampersand</x18tc:text>
      </x18tc:threadedComment>
    </x18tc:ThreadedComments>`;
    const comments = parseThreadedCommentXml(xml);
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      ref: "K3",
      guid: "c1",
      personId: "p1",
      dt: "2025-12-03T19:19:55.00",
      text: "Initial issue text",
    });
    expect(comments[0].parentGuid).toBeUndefined();
    expect(comments[1]).toMatchObject({ guid: "c2", parentGuid: "c1" });
    // XML entity decoding
    expect(comments[1].text).toBe("Reply with & ampersand");
  });
});

describe("mapExcelStatusName", () => {
  it.each([
    ["Service Call", "C.S. In process", "Service Call"],
    ["Needs Attention", "C.S. In process", "Needs Attention"],
    ["Replacement on Order", "C.S. In process", "Waiting on Vendor"],
    ["", "C.S. In process", "Open"],
    [undefined, "C.S. In process", "Open"],
    // Completed sheet is uniformly closed — value doesn't matter.
    ["anything at all", "C.S. Completed", "Completed"],
    ["", "C.S. Completed", "Completed"],
    // Other recognized synonyms
    ["In Progress", "Repair", "In Progress"],
    ["Cancelled", "Repair", "Cancelled"],
    ["Canceled", "Repair", "Cancelled"],
    ["Waiting on Parts", "Repair", "Waiting on Parts"],
  ])("maps %p on sheet %p to %p", (input, sheet, expected) => {
    expect(mapExcelStatusName(input, sheet)).toBe(expected);
  });

  it("falls back to Open for unrecognized values", () => {
    expect(mapExcelStatusName("Some new status", "C.S. In process")).toBe("Open");
  });
});

describe("extractSalesOrderTokens", () => {
  it("pulls every order token from a mashed-together cell, excluding PO tokens", () => {
    const raw = "PONO6186 SO2986 Ack #249207 INV28978-A";
    const toks = extractSalesOrderTokens(raw);
    expect(toks).toContain("SO2986");
    expect(toks).toContain("INV28978 - A");
    expect(toks).not.toContain("PONO6186");
    expect(toks).not.toContain("PON6186");
  });

  it("normalizes rewrite-suffix spacing and uppercases", () => {
    expect(extractSalesOrderTokens("SO12345-A")).toEqual(["SO12345 - A"]);
    expect(extractSalesOrderTokens("so12345 - b")).toEqual(["SO12345 - B"]);
  });

  it("matches any alphabetic-prefix order scheme", () => {
    expect(extractSalesOrderTokens("ORD1 SALE2 WEB3").sort()).toEqual(
      ["ORD1", "SALE2", "WEB3"].sort(),
    );
  });

  it("returns [] for empty / missing input", () => {
    expect(extractSalesOrderTokens(undefined)).toEqual([]);
    expect(extractSalesOrderTokens("")).toEqual([]);
    expect(extractSalesOrderTokens("no orders here")).toEqual([]);
  });
});

describe("extractPoTokens", () => {
  it("pulls PONO and PON variants", () => {
    expect(extractPoTokens("PONO6186 PON04217")).toEqual(
      expect.arrayContaining(["PONO6186", "PON04217"]),
    );
  });
});

describe("poNumberCandidates", () => {
  // the POS stores `PurchaseOrder.poNumber` as `PON` + 5-digit
  // zero-padded number; the spreadsheet variably uses PONO12345 (no
  // pad) or PON04217 (with pad). The candidate set MUST include the
  // canonical 5-digit form so a sheet-side `PONO6186` matches the
  // DB-side `PON06186`.
  it("normalizes PONO6186 → PON06186 (canonical 5-digit pad)", () => {
    const out = poNumberCandidates("PONO6186");
    expect(out).toContain("PON06186");
    expect(out).toContain("PONO6186"); // also try exact original
    expect(out).toContain("PON6186"); // and the unpadded PON variant
  });

  it("normalizes PON6186 → PON06186 too", () => {
    expect(poNumberCandidates("PON6186")).toContain("PON06186");
  });

  it("passes the already-canonical PON04217 through unchanged", () => {
    expect(poNumberCandidates("PON04217")).toContain("PON04217");
  });

  it("accepts mixed case from the sheet (`pono6186`)", () => {
    expect(poNumberCandidates("pono6186")).toContain("PON06186");
  });

  it("returns [] for non-PO tokens", () => {
    expect(poNumberCandidates("SO12345")).toEqual([]);
    expect(poNumberCandidates("XYZ")).toEqual([]);
    expect(poNumberCandidates("")).toEqual([]);
  });
});

describe("normalizePhone", () => {
  it("strips formatting, drops leading 1 country code", () => {
    expect(normalizePhone("860-470-3653")).toBe("8604703653");
    expect(normalizePhone("(860) 470-3653")).toBe("8604703653");
    expect(normalizePhone("1-860-470-3653")).toBe("8604703653");
    expect(normalizePhone("+18604703653")).toBe("8604703653");
  });

  it("returns empty string for blank input", () => {
    expect(normalizePhone(undefined)).toBe("");
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone("--")).toBe("");
  });
});

describe("resolveAuthor", () => {
  const staffByEmail = new Map([["alex@example.com", 100]]);
  const staffByName = new Map([
    ["rebecca warren", 101],
    ["alex robertson", 100],
  ]);

  it("matches by email when userId is set", () => {
    const r = resolveAuthor(
      { displayName: "Alex Robertson", userId: "alex@example.com" },
      staffByEmail,
      staffByName,
    );
    expect(r).toEqual({ authorId: 100, authorDisplayName: "Alex Robertson" });
  });

  it("treats an @-containing displayName as the email hint", () => {
    const r = resolveAuthor({ displayName: "alex@example.com" }, staffByEmail, staffByName);
    expect(r.authorId).toBe(100);
  });

  it("falls back to displayName lookup case-insensitively", () => {
    const r = resolveAuthor({ displayName: "Rebecca Warren" }, staffByEmail, staffByName);
    expect(r.authorId).toBe(101);
  });

  it("returns null authorId + raw displayName when nothing matches", () => {
    const r = resolveAuthor({ displayName: "Former Staffer" }, staffByEmail, staffByName);
    expect(r).toEqual({ authorId: null, authorDisplayName: "Former Staffer" });
  });

  it("returns (unknown) when no PersonInfo at all", () => {
    const r = resolveAuthor(undefined, staffByEmail, staffByName);
    expect(r).toEqual({ authorId: null, authorDisplayName: "(unknown)" });
  });
});

describe("computeRowKey", () => {
  it("is stable across calls with the same inputs", () => {
    const a = computeRowKey({
      name: "Barbara Panagy",
      ordernoRaw: "SO12345",
      sheetName: "C.S. In process",
    });
    const b = computeRowKey({
      name: "Barbara Panagy",
      ordernoRaw: "SO12345",
      sheetName: "C.S. In process",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^cs-sheet:[0-9a-f]{24}$/);
  });

  it("normalizes whitespace + case so trivial edits don't break idempotency", () => {
    const a = computeRowKey({
      name: "Barbara Panagy",
      ordernoRaw: "SO12345",
      sheetName: "C.S. In process",
    });
    const b = computeRowKey({
      name: "  barbara panagy ",
      ordernoRaw: " so12345  ",
      sheetName: "c.s. in process",
    });
    expect(a).toBe(b);
  });

  it("differentiates by sheet name (a row that moves from In Process → Completed gets a new key)", () => {
    const ip = computeRowKey({
      name: "Same Person",
      ordernoRaw: "SO1",
      sheetName: "C.S. In process",
    });
    const done = computeRowKey({
      name: "Same Person",
      ordernoRaw: "SO1",
      sheetName: "C.S. Completed",
    });
    expect(ip).not.toBe(done);
  });

  it("IGNORES timestamp so an operator can correct the date and re-import without duplicating", () => {
    // This is the contract change of 2026-05-27 — timestamp used to
    // be part of the hash; now it's not. A row whose Timestamp gets
    // edited still resolves to the same case, which is the whole
    // point of the recurring-sync workflow.
    const a = computeRowKey({
      timestamp: new Date("2025-10-03T00:00:00Z"),
      name: "Customer",
      ordernoRaw: "SO1",
      sheetName: "C.S. In process",
    });
    const b = computeRowKey({
      timestamp: new Date("2025-12-15T00:00:00Z"),
      name: "Customer",
      ordernoRaw: "SO1",
      sheetName: "C.S. In process",
    });
    const c = computeRowKey({
      // Timestamp omitted altogether
      name: "Customer",
      ordernoRaw: "SO1",
      sheetName: "C.S. In process",
    });
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("works without a timestamp at all (no crash)", () => {
    expect(() => computeRowKey({ name: "X", sheetName: "C.S. In process" })).not.toThrow();
  });
});

describe("anchorDateOnlyToLocalNoon", () => {
  // The first import surfaced a TZ-rollback bug: sheetjs returns a
  // date-only Excel cell ("10/3/2025") as a Date at UTC midnight,
  // which in any timezone WEST of UTC (including America/New_York)
  // displays as the PREVIOUS day. Anchoring to local noon makes the
  // wall-clock date safe across every realistic TZ offset (-12 to
  // +14 hours).

  it("shifts a UTC-midnight Date to local noon of the same Y/M/D", () => {
    const utcMidnight = new Date(Date.UTC(2025, 9, 3, 0, 0, 0)); // Oct 3, 2025 00:00 UTC
    const anchored = anchorDateOnlyToLocalNoon(utcMidnight);
    expect(anchored.getFullYear()).toBe(2025);
    expect(anchored.getMonth()).toBe(9); // October
    expect(anchored.getDate()).toBe(3);
    expect(anchored.getHours()).toBe(12);
    // Same UTC date — the shift preserves the wall-clock day in any
    // local TZ, but the underlying instant differs from the input by
    // the local offset.
    expect(anchored.getTime()).not.toBe(utcMidnight.getTime());
  });

  it("passes datetimes with non-zero time through unchanged (operator typed a specific time)", () => {
    const withTime = new Date(Date.UTC(2025, 9, 3, 14, 30, 0)); // 2:30 PM UTC
    const out = anchorDateOnlyToLocalNoon(withTime);
    expect(out.getTime()).toBe(withTime.getTime());
  });
});

describe("coerceDate", () => {
  it("anchors a UTC-midnight Date object to local noon", () => {
    // What sheetjs hands us for a date-only Excel cell "10/3/2025"
    const utcMidnight = new Date(Date.UTC(2025, 9, 3, 0, 0, 0));
    const out = coerceDate(utcMidnight)!;
    expect(out.getFullYear()).toBe(2025);
    expect(out.getMonth()).toBe(9);
    expect(out.getDate()).toBe(3);
    // Wall-clock day MUST equal Oct 3 in any timezone the test runs in.
  });

  it("returns undefined for blank input", () => {
    expect(coerceDate(undefined)).toBeUndefined();
    expect(coerceDate(null)).toBeUndefined();
    expect(coerceDate("")).toBeUndefined();
  });

  it("returns undefined for unparseable strings (doesn't throw)", () => {
    expect(coerceDate("not a date")).toBeUndefined();
  });

  it("preserves an explicit time-of-day Date as-is", () => {
    const withTime = new Date(2025, 9, 3, 14, 30, 0);
    const out = coerceDate(withTime)!;
    expect(out.getHours()).toBe(14);
  });
});

describe("parseThreadedCommentDate", () => {
  // Excel + Google Sheets emit the threaded-comment `dT` attribute
  // as UTC but without the `Z` suffix. `new Date(rawDt)` then
  // interprets it as LOCAL time, which differs across the dev
  // machine (America/New_York) and a UTC Docker container. We force
  // UTC interpretation so the underlying instant is deterministic
  // regardless of where the importer runs.

  it("treats a no-suffix dT as UTC", () => {
    const dt = "2025-12-03T19:19:55.00";
    const d = parseThreadedCommentDate(dt);
    // 19:19:55 UTC must round-trip via getUTCHours, not getHours.
    expect(d.getUTCFullYear()).toBe(2025);
    expect(d.getUTCMonth()).toBe(11); // December
    expect(d.getUTCDate()).toBe(3);
    expect(d.getUTCHours()).toBe(19);
    expect(d.getUTCMinutes()).toBe(19);
    expect(d.getUTCSeconds()).toBe(55);
  });

  it("strips a non-standard sub-second tail (`.00`) that breaks the JS Date parser", () => {
    // Without the strip, `new Date("2025-12-03T19:19:55.00Z")` is
    // unstable across engines (some accept it, some return Invalid).
    expect(parseThreadedCommentDate("2025-12-03T19:19:55.00").getTime()).toBeGreaterThan(0);
    expect(parseThreadedCommentDate("2025-12-03T19:19:55.123").getTime()).toBeGreaterThan(0);
    expect(parseThreadedCommentDate("2025-12-03T19:19:55").getTime()).toBeGreaterThan(0);
  });

  it("respects an explicit Z if already present", () => {
    const a = parseThreadedCommentDate("2025-12-03T19:19:55Z").getTime();
    const b = parseThreadedCommentDate("2025-12-03T19:19:55").getTime();
    expect(a).toBe(b);
  });

  it("respects an explicit +HH:MM offset", () => {
    // 19:19:55 in +05:00 = 14:19:55 UTC
    const d = parseThreadedCommentDate("2025-12-03T19:19:55+05:00");
    expect(d.getUTCHours()).toBe(14);
  });
});

describe("generateImportedCaseNumber", () => {
  it("is deterministic + prefixed with CSI- so import-vs-native is obvious", () => {
    const n = generateImportedCaseNumber("cs-sheet:abc123def456789012345678");
    expect(n).toBe("CSI-ABC123DEF4");
  });
});
