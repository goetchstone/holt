// /app/__tests__/automationKeyTripwire.test.ts
//
// Bug class: a request-supplied secret compared with `===` / `!==`. String
// equality returns at the first differing byte, so timing leaks the secret a
// prefix at a time. AUTO_IMPORT_API_KEY was compared that way inline in five
// places; the shared `authorizedByAutoImportKey` (guardAutomation.ts) now does
// it constant-time and is the only home for the comparison.
//
// This is a source-text check, which is only legitimate for a "this guard must
// exist everywhere" invariant like this one: the behaviour of the shared helper
// is tested for real in guardAutomation.test.ts, and what this proves is that no
// route went back to comparing the header itself. It fails when any file under
// src compares an authorization header to a `Bearer ${...}` template.

import fs from "fs";
import path from "path";

const SRC = path.join(__dirname, "..", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

// authorization ... ===/!== `Bearer ${  (either operand order)
const BAD_COMPARE =
  /authorization[^\n;]*?[!=]==\s*`Bearer\s*\$\{|`Bearer\s*\$\{[^`]*`\s*[!=]==[^\n;]*authorization/i;

describe("no inline Bearer comparison", () => {
  it("matcher catches the old shapes", () => {
    expect(BAD_COMPARE.test("req.headers.authorization === `Bearer ${key}`")).toBe(true);
    expect(BAD_COMPARE.test("if (`Bearer ${k}` !== req.headers.authorization)")).toBe(true);
    expect(BAD_COMPARE.test("timingSafeEqual(a, b)")).toBe(false);
  });

  it("no file under src compares an authorization header with ===/!== to a Bearer template", () => {
    const offenders = walk(SRC)
      .filter((f) => BAD_COMPARE.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
