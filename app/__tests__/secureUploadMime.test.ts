// /app/__tests__/secureUploadMime.test.ts
//
// SEC-10: the imports preset (CSV_XLSX) listed application/octet-stream among
// its allowed types, which made the "reject an unlisted mime" branch dead --
// EVERY declared type passed and the extension was the only real gate, so an
// .exe renamed .xlsx and typed application/x-msdownload sailed through. These
// pin the restored both-must-match behaviour, and that a legitimate CSV typed
// text/plain still gets in.

import { isUploadAllowed, UPLOAD_PRESETS } from "@/lib/secureUpload";

const CSV = UPLOAD_PRESETS.CSV_XLSX;
const PDF = UPLOAD_PRESETS.PDF;

describe("isUploadAllowed", () => {
  it("accepts an .xlsx sent as the generic application/octet-stream", () => {
    expect(isUploadAllowed(CSV, "sales.xlsx", "application/octet-stream")).toBe(true);
  });

  it("accepts a .csv sent as text/plain (some browsers do)", () => {
    expect(isUploadAllowed(CSV, "customers.csv", "text/plain")).toBe(true);
  });

  it("accepts a .csv sent as its real text/csv type", () => {
    expect(isUploadAllowed(CSV, "customers.csv", "text/csv")).toBe(true);
  });

  it("refuses an executable renamed .xlsx and typed application/x-msdownload", () => {
    // The bug: octet-stream in the list made this pass. It must not.
    expect(isUploadAllowed(CSV, "payload.xlsx", "application/x-msdownload")).toBe(false);
  });

  it("refuses a .xlsx whose declared type is an image", () => {
    expect(isUploadAllowed(CSV, "evil.xlsx", "image/png")).toBe(false);
  });

  it("refuses a wrong extension regardless of mime", () => {
    expect(isUploadAllowed(CSV, "payload.exe", "text/csv")).toBe(false);
  });

  it("accepts when the browser sends no mime and the extension matches", () => {
    expect(isUploadAllowed(CSV, "sales.csv", undefined)).toBe(true);
  });

  it("keeps octet-stream per-preset: a .pdf typed octet-stream is refused, its real type accepted", () => {
    expect(isUploadAllowed(PDF, "book.pdf", "application/octet-stream")).toBe(false);
    expect(isUploadAllowed(PDF, "book.pdf", "application/pdf")).toBe(true);
  });
});
