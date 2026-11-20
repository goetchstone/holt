// /app/__tests__/csvExportManifest.test.ts
//
// Rule 65 manifest + tripwire for CSV formula injection. A spreadsheet runs a
// cell that starts with = + - @ tab or CR as a formula, and customer, product
// and note fields are user-entered, so every CSV an export produces must go
// through the one neutraliser (lib/csv.ts neutraliseFormulaCell, reached via
// csvCell/csvRow in lib/csvExport.ts, rowsToCsv/neutraliseRow in lib/csv.ts).
//
// __tests__/fixtures/csv-producers.txt lists every file under src/ that matches
// the CSV grep, each marked `helper` or `excluded: <reason>`. This fails when:
//   (a) a file matches the grep and is not in the manifest,
//   (b) a manifest entry's file is gone or no longer matches the grep,
//   (c) an `excluded` entry has no reason,
//   (d) a `helper` entry does not import a helper.
// The behaviour itself is in csvFormulaInjection.test.ts; this only proves the
// set of producers stays covered.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const APP_DIR = join(__dirname, "..");
const SRC = join(APP_DIR, "src");

// The same grep used to enumerate producers by hand.
const CSV_PATTERN =
  /text\/csv|\.csv\b|Content-Disposition|Papa\.unparse|AsyncParser|\bcsvRow\(|\browsToCsv\(|\bcsvCell\b|neutraliseRow/;
const HELPER_IMPORT = /from\s+["'](?:@\/lib\/|\.\/|\.\.\/|(?:\.\.\/)+lib\/)csv(?:Export)?["']/;
// A helper entry must use one, not only import it: called, or passed as a value
// (`rows.map(neutraliseRow)`, `row.map(csvCell)`), anywhere but the import line.
const HELPER_USE =
  /\b(?:csvCell|csvRow|crlfCsv|rowsToCsv|neutraliseRow|neutraliseFormulaCell|escapeCell)\b/;
const usesHelper = (text: string) =>
  text.split("\n").some((l) => !/^\s*import\b/.test(l) && HELPER_USE.test(l));
// A CSV row joined by hand, ending in a line break: what the helpers replace.
// `(?:\\r)?` makes the whole `\r` optional; `\\r?` would leave its backslash required.
const HAND_ROW =
  /\.join\(\s*["'],["']\s*\)\s*\+\s*["'](?:\\r)?\\n["']|\.join\(\s*["'],["']\s*\)\}(?:\\r)?\\n`/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Files under src/ matching the CSV grep, as app-relative paths. */
export function findProducers(): string[] {
  return walk(SRC)
    .filter((f) => CSV_PATTERN.test(readFileSync(f, "utf8")))
    .map((f) => relative(APP_DIR, f))
    .sort();
}

type Entry = { file: string; kind: "helper" | "excluded" | "invalid"; reason: string };

export function parseManifest(text: string): Entry[] {
  const entries: Entry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(" | ");
    const file = (i < 0 ? line : line.slice(0, i)).trim();
    const status = i < 0 ? "" : line.slice(i + 3).trim();
    if (status === "helper") entries.push({ file, kind: "helper", reason: "" });
    else if (status.startsWith("excluded:"))
      entries.push({ file, kind: "excluded", reason: status.slice("excluded:".length).trim() });
    else entries.push({ file, kind: "invalid", reason: status });
  }
  return entries;
}

const MANIFEST = parseManifest(
  readFileSync(join(__dirname, "fixtures", "csv-producers.txt"), "utf8"),
);

describe("CSV producer manifest (formula injection)", () => {
  it("parses: every line is `helper` or `excluded: <reason>`", () => {
    expect(MANIFEST.filter((e) => e.kind === "invalid")).toEqual([]);
  });

  it("(a) every file that produces CSV is in the manifest", () => {
    const listed = new Set(MANIFEST.map((e) => e.file));
    const missing = findProducers().filter((f) => !listed.has(f));
    expect(missing).toEqual([]);
  });

  it("(b) every manifest entry still exists and still matches the CSV grep", () => {
    const stale = MANIFEST.filter((e) => {
      try {
        return !CSV_PATTERN.test(readFileSync(join(APP_DIR, e.file), "utf8"));
      } catch {
        return true;
      }
    }).map((e) => e.file);
    expect(stale).toEqual([]);
  });

  it("(c) every excluded entry carries a reason", () => {
    const bare = MANIFEST.filter((e) => e.kind === "excluded" && e.reason.length < 8).map(
      (e) => e.file,
    );
    expect(bare).toEqual([]);
  });

  it("(d) every helper entry imports and uses a CSV helper, and joins no row by hand", () => {
    const bad = MANIFEST.filter((e) => {
      if (e.kind !== "helper") return false;
      const text = readFileSync(join(APP_DIR, e.file), "utf8");
      return !HELPER_IMPORT.test(text) || !usesHelper(text) || HAND_ROW.test(text);
    }).map((e) => e.file);
    expect(bad).toEqual([]);
  });

  it("(d) the hand-built-row check can disagree", () => {
    expect(HAND_ROW.test('lines.push(cells.join(",") + "\\n");')).toBe(true);
    expect(HAND_ROW.test('out += `${cells.join(",")}\\r\\n`;')).toBe(true);
    expect(HAND_ROW.test('const inList = ids.join(",");')).toBe(false);
    expect(usesHelper('import { csvCell } from "@/lib/csvExport";\nconst x = 1;')).toBe(false);
    expect(usesHelper('import { csvCell } from "@/lib/csvExport";\nrow.map(csvCell)')).toBe(true);
  });

  it("has no duplicate entries", () => {
    const files = MANIFEST.map((e) => e.file);
    expect(files.length).toBe(new Set(files).size);
  });

  it("the detector itself can disagree (flags an unlisted producer)", () => {
    const listed = new Set(MANIFEST.map((e) => e.file));
    listed.delete("src/pages/api/reports/traffic/export.ts");
    expect(findProducers().filter((f) => !listed.has(f))).toEqual([
      "src/pages/api/reports/traffic/export.ts",
    ]);
  });
});
