// app/scripts/wholesale-coverage.impl.ts
//
// Price-book coverage. Runs every book in the manifest through the same
// parsePriceBook() the importer uses, and checks the result against what the
// manifest says to expect. COUNTS ONLY -- this never prints or writes a price.
//
// The manifest (wholesale-coverage.expected.json) is exhaustive (CLAUDE.md rule
// 65): every PDF in every `<vendor>/wholesale/` folder under --dir -- and in any
// other folder an entry names -- must be claimed by exactly one entry, and each
// entry states its expectation: "parsed" with a style count, or "refused" /
// "unsupported" with the reason. The run fails in both directions: a book that
// stops parsing, or drifts outside the count tolerance, fails; so does a PDF
// nobody has classified yet. A new edition arrives as a red run, not a silent gap.
//
// The price books are private and never enter this repo: --dir points at
// wherever they live, and every file this writes must land OUTSIDE the repo.
//
// Usage (from app/, via the launcher):
//   node scripts/wholesale-coverage.mjs --dir ~/pricelists
//   node scripts/wholesale-coverage.mjs --dir ~/pricelists --out /tmp/coverage.json
//   node scripts/wholesale-coverage.mjs --render "<book.pdf>" --out /tmp/page.txt [--page 3]
//
// --render dumps the column-aware rendered text a profile is written against
// (all pages, or one), for authoring a new vendor profile.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parsePriceBook,
  parseIsRefused,
  UnsupportedTypeError,
  UnsupportedVendorError,
} from "@/lib/pricing/parsePriceBook";
import { columnAwarePageRenderer, parsePdf } from "@/lib/pricing/pdfUtils";

const APP_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(APP_ROOT, "..");
const DEFAULT_MANIFEST = path.join(__dirname, "wholesale-coverage.expected.json");

type Status = "parsed" | "refused" | "unsupported" | "error" | "missing" | "ambiguous";

export interface Expectation {
  status: "parsed" | "refused" | "unsupported";
  /** Required for "parsed": the style count the book yields. */
  count?: number;
  /** Required for anything but "parsed": why it does not parse today. */
  reason?: string;
}

export interface BookEntry {
  id: string;
  /** Folder relative to --dir, e.g. "Hooker/wholesale". */
  dir: string;
  /** Case-insensitive fragment of the book's title that picks it out of `dir`. */
  match: string;
  vendor: string;
  type: string;
  expect?: Expectation;
}

export interface Manifest {
  /** Allowed relative drift in a parsed book's count before the run fails. */
  tolerance: number;
  books: BookEntry[];
}

interface BookResult {
  id: string;
  vendor: string;
  type: string;
  status: Status;
  count: number | null;
  errorDiagnostics: string[];
  ms: number;
  verdict: "ok" | "FAIL";
  why?: string;
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// Book text and diagnostics must never be written into the repo, where a stray
// `git add` would publish them. Refuse, rather than trust the caller.
function assertOutsideRepo(file: string): string {
  const resolved = path.resolve(expandHome(file));
  if (resolved === REPO_ROOT || resolved.startsWith(REPO_ROOT + path.sep)) {
    throw new Error(`refusing to write ${resolved}: output must be outside the repository`);
  }
  return resolved;
}

function loadManifest(file: string): Manifest {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
  if (!Array.isArray(raw.books)) throw new Error(`${file}: "books" must be an array`);
  const ids = new Set<string>();
  for (const b of raw.books) {
    if (ids.has(b.id)) throw new Error(`${file}: duplicate book id "${b.id}"`);
    ids.add(b.id);
  }
  return { tolerance: typeof raw.tolerance === "number" ? raw.tolerance : 0.1, books: raw.books };
}

/** Every `<vendor>/wholesale` folder under the root, relative to it. */
function wholesaleFolders(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(d.name, "wholesale"))
    .filter((rel) => fs.existsSync(path.join(root, rel)));
}

function pdfsIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".pdf"));
}

async function parseBook(file: string, vendor: string, type: string) {
  const started = Date.now();
  try {
    const parse = await parsePriceBook(fs.readFileSync(file), vendor, type);
    return {
      status: (parseIsRefused(parse) ? "refused" : "parsed") as Status,
      count: parse.count,
      errorDiagnostics: parse.diagnostics.filter((d) => d.level === "error").map((d) => d.message),
      ms: Date.now() - started,
    };
  } catch (err) {
    const unsupported =
      err instanceof UnsupportedVendorError || err instanceof UnsupportedTypeError;
    return {
      status: (unsupported ? "unsupported" : "error") as Status,
      count: null,
      errorDiagnostics: [err instanceof Error ? err.message : String(err)],
      ms: Date.now() - started,
    };
  }
}

/** Whether one book's result matches its manifest expectation. Exported for the unit test. */
export function judge(
  result: Pick<BookResult, "status" | "count">,
  expect: Expectation | undefined,
  tolerance: number,
): { verdict: "ok" | "FAIL"; why?: string } {
  if (!expect) return { verdict: "FAIL" as const, why: "no expectation in the manifest" };
  if (expect.status !== "parsed" && !expect.reason) {
    return { verdict: "FAIL" as const, why: `expected "${expect.status}" without a reason` };
  }
  if (result.status !== expect.status) {
    return { verdict: "FAIL" as const, why: `expected ${expect.status}, got ${result.status}` };
  }
  if (expect.status === "parsed") {
    if (typeof expect.count !== "number" || expect.count <= 0) {
      return { verdict: "FAIL" as const, why: "a parsed book needs an expected count" };
    }
    const drift = Math.abs((result.count ?? 0) - expect.count) / expect.count;
    if (drift > tolerance) {
      return {
        verdict: "FAIL" as const,
        why: `count ${result.count} is outside ${expect.count} ±${Math.round(tolerance * 100)}%`,
      };
    }
  }
  return { verdict: "ok" as const };
}

// Find the one PDF an entry names, claim it, parse it, and judge the result.
// `claimed` is shared across entries so two entries cannot own one book.
async function measureBook(
  book: BookEntry,
  root: string,
  claimed: Map<string, string>,
  tolerance: number,
): Promise<BookResult> {
  const folder = path.join(root, book.dir);
  const hits = pdfsIn(folder).filter((f) => f.toLowerCase().includes(book.match.toLowerCase()));
  const base = { id: book.id, vendor: book.vendor, type: book.type };
  const unmeasured = (status: Status, why: string): BookResult => ({
    ...base,
    status,
    count: null,
    errorDiagnostics: [],
    ms: 0,
    verdict: "FAIL",
    why,
  });

  if (hits.length === 0)
    return unmeasured("missing", `no PDF in ${book.dir} matches "${book.match}"`);
  if (hits.length > 1) {
    return unmeasured("ambiguous", `"${book.match}" matches ${hits.length} PDFs in ${book.dir}`);
  }
  const file = path.join(folder, hits[0]);
  const previous = claimed.get(file);
  if (previous) return unmeasured("ambiguous", `same PDF already claimed by "${previous}"`);
  claimed.set(file, book.id);

  const result = { ...base, ...(await parseBook(file, book.vendor, book.type)) };
  return { ...result, ...judge(result, book.expect, tolerance) };
}

async function runCoverage(args: string[]): Promise<number> {
  const dirArg = argValue(args, "--dir");
  if (!dirArg) throw new Error("--dir <folder of price books> is required");
  const root = path.resolve(expandHome(dirArg));
  const manifest = loadManifest(argValue(args, "--manifest") ?? DEFAULT_MANIFEST);
  const outFile = argValue(args, "--out");
  const outPath = outFile ? assertOutsideRepo(outFile) : undefined;

  const results: BookResult[] = [];
  const claimed = new Map<string, string>(); // absolute pdf path -> book id
  for (const book of manifest.books) {
    results.push(await measureBook(book, root, claimed, manifest.tolerance));
  }

  // The other direction: every PDF must be classified. The folders are defined by
  // the filesystem, not by the manifest -- deriving them from the entries would
  // let a new vendor, or a book whose entry was deleted, go unseen.
  const folders = [...new Set([...wholesaleFolders(root), ...manifest.books.map((b) => b.dir)])];
  const unclassified = folders.flatMap((dir) =>
    pdfsIn(path.join(root, dir))
      .filter((f) => !claimed.has(path.join(root, dir, f)))
      .map((f) => path.join(dir, f)),
  );

  printTable(results, unclassified);

  if (outPath) {
    const report = {
      generatedAt: new Date().toISOString(),
      tolerance: manifest.tolerance,
      results,
      unclassified,
    };
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`\nreport: ${outPath}`);
  }

  const failed = results.filter((r) => r.verdict === "FAIL").length + unclassified.length;
  const parsedBooks = results.filter((r) => r.status === "parsed");
  const vendors = new Set(parsedBooks.map((r) => r.vendor));
  console.log(
    `\ncoverage: ${parsedBooks.length} of ${results.length} books parse, across ${vendors.size} vendors` +
      (failed ? ` — ${failed} problem(s)` : " — matches the manifest"),
  );
  return failed ? 1 : 0;
}

function printTable(results: BookResult[], unclassified: string[]): void {
  const rows = results.map((r) => [
    r.verdict,
    r.id,
    r.vendor,
    r.type,
    r.status,
    r.count === null ? "-" : String(r.count),
    `${r.ms}ms`,
    r.why ?? "",
  ]);
  const header = ["", "book", "vendor", "type", "status", "count", "time", ""];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  console.log(line(header));
  for (const row of rows) console.log(line(row));
  for (const r of results) {
    if (r.verdict === "FAIL" && r.errorDiagnostics.length) {
      console.log(`\n${r.id}:`);
      for (const d of r.errorDiagnostics) console.log(`  - ${d}`);
    }
  }
  if (unclassified.length) {
    console.log("\nFAIL  PDFs no manifest entry claims (add an entry for each):");
    for (const f of unclassified) console.log(`  ${f}`);
  }
}

async function runRender(args: string[]): Promise<number> {
  const book = argValue(args, "--render");
  const outFile = argValue(args, "--out");
  if (!book || !outFile) throw new Error("--render <book.pdf> needs --out <file outside the repo>");
  const outPath = assertOutsideRepo(outFile);
  const data = await parsePdf(fs.readFileSync(path.resolve(expandHome(book))), {
    pagerender: columnAwarePageRenderer,
  });
  const pageArg = argValue(args, "--page");
  let text: string = data.text;
  if (pageArg) {
    const marker = `\f<<PAGE:${Number(pageArg)}>>\n`;
    const start = text.indexOf(marker);
    if (start < 0)
      throw new Error(`page ${pageArg} not found (the book has ${data.numpages} pages)`);
    const next = text.indexOf("\f<<PAGE:", start + marker.length);
    text = text.slice(start, next < 0 ? undefined : next);
  }
  fs.writeFileSync(outPath, text);
  console.log(`rendered ${pageArg ? `page ${pageArg}` : `${data.numpages} pages`} -> ${outPath}`);
  return 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  return args.includes("--render") ? runRender(args) : runCoverage(args);
}

// Run only when executed (via the launcher), not when the unit test imports judge().
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`wholesale-coverage: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
