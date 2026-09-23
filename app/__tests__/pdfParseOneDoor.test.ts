// /app/__tests__/pdfParseOneDoor.test.ts
//
// Every PDF reaches pdf.js through pdfUtils.parsePdf. pdf-parse bundles pdf.js
// 1.10, which misreads a Node Buffer ("bad XRef entry" on Node 20, and under
// Jest on Node 24); parsePdf hands it a plain Uint8Array. #190 found that and
// fixed pdfUtils; sixteen other files imported pdf-parse themselves and
// passed a Buffer. A guard on one path is no guard (principle 3), so this
// fails on any other import of pdf-parse, in any form or quote style.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const APP = join(__dirname, "..");
const ONE_DOOR = "src/lib/pricing/pdfUtils.ts";
// import pdf from "pdf-parse" / require("pdf-parse") / import("pdf-parse"),
// including subpaths like "pdf-parse/lib/pdf-parse.js".
const IMPORT =
  String.raw`(from[[:space:]]+|require\([[:space:]]*|import\([[:space:]]*)["'` +
  "`" +
  String.raw`]pdf-parse`;

function importsOfPdfParse(): string[] {
  try {
    return execFileSync("grep", ["-rnE", IMPORT, "src", "scripts"], { cwd: APP, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (err) {
    // grep exits 1 when nothing matches; anything else is an error, not a pass.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

describe("pdf-parse has one door", () => {
  it("is imported by pdfUtils.ts and nothing else", () => {
    const hits = importsOfPdfParse();
    expect(hits.filter((h) => h.startsWith(`${ONE_DOOR}:`))).toHaveLength(1);
    expect(hits.filter((h) => !h.startsWith(`${ONE_DOOR}:`))).toEqual([]);
  });
});
