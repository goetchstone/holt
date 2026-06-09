// /app/src/lib/serviceCaseSheetImport.ts
//
// Pure parsers + matchers for the Customer Service Sheet import.
// One module that knows:
//
//   1. How to read a .xlsx workbook buffer into normalized row +
//      threaded-comment data (using fflate for the raw zip + a
//      minimal XML parser for the threaded-comment + person XML).
//   2. How to map sheet values onto ServiceCase + ServiceCaseNote
//      fields (status table, designer name lookup, sales-order token
//      extraction, customer matching).
//   3. How to compute a stable idempotency key per row so the
//      importer can re-run without duplicating cases.
//
// All exports are pure (no Prisma calls) so the unit tests can pin
// the parsing + matching logic against fixture buffers + in-memory
// lookup maps. The orchestrator in lib/runServiceCaseSheetImport.ts
// glues these to actual DB queries.

import { unzipSync, strFromU8 } from "fflate";
import * as XLSX from "xlsx";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One threaded-comment entry pulled from `xl/threadedComments/*.xml`.
 * The GUID is globally unique (set by Excel / Google Sheets); we use
 * it as the per-note idempotency key.
 */
export interface ThreadedComment {
  /** Cell reference inside the sheet, e.g. "K3". */
  ref: string;
  /** Comment GUID (no braces). Stable across re-imports. */
  guid: string;
  /** Optional parent comment GUID for thread replies. */
  parentGuid?: string;
  /** Author personId (no braces). Resolves via PersonMap. */
  personId: string;
  /** ISO timestamp string from the comment metadata. */
  dt: string;
  /** Free-text body. */
  text: string;
}

export interface PersonInfo {
  /** "Jane Doe" or "jdoe@example.com" */
  displayName: string;
  /** Userid hint when present (often the email). */
  userId?: string;
}

export type PersonMap = Map<string, PersonInfo>;

/**
 * One normalized service-case row. We collapse columns from the
 * different sheets onto this single shape so the orchestrator can
 * treat them uniformly.
 */
export interface SheetRow {
  /** Which tab the row came from. */
  sheetName: string;
  /** 1-indexed row number on the sheet — for error messages. */
  rowNumber: number;
  /** Idempotency key. SHA256(timestamp+name+orderno_raw), prefixed. */
  rowKey: string;
  /** Customer Service Sheet's "Timestamp" or "Start Date" column. */
  timestamp?: Date;
  name: string;
  phone?: string;
  email?: string;
  preferredContact?: string;
  vendor?: string;
  /** Raw status text from the spreadsheet. */
  statusText?: string;
  /** Raw "Order #" cell — may contain multiple tokens. */
  ordernoRaw?: string;
  itemno?: string;
  /** Designer first name as typed. */
  designer?: string;
  /** "Initial Issue, Status Update, and Notes" cell value. */
  initialIssue?: string;
  /** Comments anchored to this row's cell K. */
  comments: ThreadedComment[];
}

export interface ParsedWorkbook {
  rows: SheetRow[];
  persons: PersonMap;
  /** Mapping from sheet name to comments-XML filename (for traceability). */
  sheetCommentFiles: Map<string, string>;
  /** Sheet-level errors (file unparseable, comment XML malformed, etc.) */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// XML helpers (just enough to read threaded-comment + person XML)
// ---------------------------------------------------------------------------
//
// We avoid pulling in a full XML parser (no project precedent) and
// rely on regex against the well-known x18tc element shape. The XML
// shape is fixed by Microsoft's spec — these regexes are robust
// against arbitrary text bodies because we capture XML-attribute and
// element-text contexts separately.

// Attribute order inside <x18tc:person> varies across exports
// (sometimes displayName→id→userId, sometimes userId before
// displayName). We parse the inner attribute string via `attr()`
// rather than a brittle positional regex.
const PERSON_TAG_RE = /<x18tc:person\b([^/>]*?)\/>/g;

const TC_RE = /<x18tc:threadedComment\b([^>]*?)>\s*<x18tc:text[^>]*?>([\s\S]*?)<\/x18tc:text>/g;

function attr(s: string, name: string): string | undefined {
  const m = new RegExp(String.raw`\b${name}="([^"]*)"`).exec(s);
  return m ? m[1] : undefined;
}

function stripBraces(s: string | undefined): string {
  if (!s) return "";
  return s.replaceAll(/^\{|\}$/g, "");
}

function decodeXmlText(s: string): string {
  return s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function parsePersonXml(xml: string): PersonMap {
  const out: PersonMap = new Map();
  let m: RegExpExecArray | null;
  PERSON_TAG_RE.lastIndex = 0;
  while ((m = PERSON_TAG_RE.exec(xml))) {
    const inner = m[1];
    const id = stripBraces(attr(inner, "id") || "");
    if (!id) continue;
    const displayName = attr(inner, "displayName") || "";
    const userId = attr(inner, "userId");
    if (!displayName) continue;
    out.set(id, { displayName, userId });
  }
  return out;
}

export function parseThreadedCommentXml(xml: string): ThreadedComment[] {
  const out: ThreadedComment[] = [];
  let m: RegExpExecArray | null;
  TC_RE.lastIndex = 0;
  while ((m = TC_RE.exec(xml))) {
    const [, attrs, body] = m;
    const ref = attr(attrs, "ref");
    const id = attr(attrs, "id");
    const personId = attr(attrs, "personId");
    const dt = attr(attrs, "dT");
    const parentId = attr(attrs, "parentId");
    if (!ref || !id || !personId || !dt) continue;
    out.push({
      ref,
      guid: stripBraces(id),
      parentGuid: parentId ? stripBraces(parentId) : undefined,
      personId: stripBraces(personId),
      dt,
      text: decodeXmlText(body.trim()),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Workbook parsing
// ---------------------------------------------------------------------------

/**
 * Sheets we actively import. Other tabs (`Form Responses 1`,
 * `Deliveries to Schedule`) are skipped because they're either empty
 * or out-of-scope (different domain shape).
 */
const SHEETS_TO_IMPORT = ["C.S. In process", "C.S. Completed", "Repair"];

/**
 * Map xlsx sheet position → which threadedCommentN.xml file holds
 * its comments. The relationship is declared in xl/worksheets/_rels/
 * sheetN.xml.rels but the index is reliably one-based-positional in
 * practice. We resolve via the workbook .rels mapping below.
 */
function buildSheetCommentMap(zip: Record<string, Uint8Array>): Map<string, string> {
  // Find every worksheet rels file, look for threadedComment targets.
  const out = new Map<string, string>();
  for (const name of Object.keys(zip)) {
    const m = /^xl\/worksheets\/_rels\/sheet(\d+)\.xml\.rels$/.exec(name);
    if (!m) continue;
    const sheetIdx = m[1];
    const relsXml = strFromU8(zip[name]);
    const tcMatch = /Target="[^"]*threadedComment(\d+)\.xml"/.exec(relsXml);
    if (tcMatch) {
      out.set(sheetIdx, `xl/threadedComments/threadedComment${tcMatch[1]}.xml`);
    }
  }
  return out;
}

/**
 * Map sheet display name → sheet index in workbook.xml. Sheetjs's
 * `wb.SheetNames` and `wb.Sheets` give us the names but not the
 * numeric index used by the worksheet XML filenames. We pull the
 * sheet IDs from workbook.xml's `<sheet>` elements.
 */
function buildSheetNameToIndex(zip: Record<string, Uint8Array>): Map<string, string> {
  const out = new Map<string, string>();
  const wbXml = zip["xl/workbook.xml"];
  if (!wbXml) return out;
  const xml = strFromU8(wbXml);
  const SHEET_RE = /<sheet\b([^/>]*?)\/>/g;
  let m: RegExpExecArray | null;
  let positional = 0;
  while ((m = SHEET_RE.exec(xml))) {
    positional += 1;
    const inner = m[1];
    const name = attr(inner, "name");
    // sheetId is the file-name index in the absolute majority of
    // sheets, but in some workbooks the IDs are non-contiguous; the
    // r:id rel pointer is canonical. Try sheetId first; fall back to
    // positional. Either way the THREADEDCOMMENT_N.xml maps via the
    // rels chain so this is just a name→file hint.
    const sheetId = attr(inner, "sheetId") || String(positional);
    if (name) out.set(name, sheetId);
  }
  return out;
}

const HEADER_ALIASES: Record<string, string[]> = {
  timestamp: ["Timestamp", "Start Date"],
  name: ["Client Name", "Name"],
  phone: ["Client Phone Number", "Phone #"],
  email: ["Client Email", "Email"],
  preferredContact: ["Preferred Contact Method"],
  vendor: ["Vendor"],
  statusText: ["Status"],
  ordernoRaw: ["Order Number", "Order #"],
  itemno: ["Item #"],
  designer: ["Designer"],
  initialIssue: ["Initial Issue", "Initial Issue, Status Update, and Notes"],
};

function findHeaderColumn(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const i = headers.findIndex(
      (h) => (h ?? "").toString().trim().toLowerCase() === alias.toLowerCase(),
    );
    if (i >= 0) return i;
  }
  // Header row in `C.S. In process` is corrupted (cell A1 has a policy
  // memo, not "Timestamp"). Fall back to a fuzzy "contains" match for
  // the initial-issue column which is the most important.
  for (const alias of aliases) {
    const i = headers.findIndex((h) =>
      (h ?? "").toString().toLowerCase().includes(alias.toLowerCase()),
    );
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Excel cell values come back as a mix of strings, numbers (Excel
 * serials), and Date objects. Normalize to Date | undefined.
 *
 * Timezone handling — the gotcha that bit on the first import:
 *
 *   SheetJS with cellDates:true returns a date-only cell ("10/3/2025")
 *   as a Date constructed at UTC midnight (`2025-10-03T00:00:00.000Z`).
 *   When that's stored in Postgres and displayed via the React UI
 *   running in America/New_York, the wall-clock display becomes
 *   "Oct 2, 8:00 PM" — the day BEFORE the operator typed.
 *
 *   Same shape applies to the numeric-serial fallback below: we used
 *   to construct `Date.UTC(...)` which has the identical TZ-rollback
 *   bug on the display side.
 *
 *   Fix: when the source value carries no time-of-day information
 *   (Excel's "date" format vs "datetime" format), anchor the Date to
 *   LOCAL NOON so the wall-clock date can't roll backwards across
 *   any timezone the app/DB/UI happen to run in. We accept that the
 *   "time" component is now noon-local, not midnight, but for these
 *   sheet rows the time was never meaningful — only the date is.
 */
export function coerceDate(v: unknown): Date | undefined {
  if (v == null || v === "") return undefined;
  if (v instanceof Date) return anchorDateOnlyToLocalNoon(v);
  if (typeof v === "number") {
    // SheetJS supplies a Date when cellDates: true; numeric fallback
    // fires only when a date was stored as a serial that escaped
    // that option. Use SheetJS's converter, then anchor.
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return undefined;
    const hasTime = d.H !== 0 || d.M !== 0 || d.S !== 0;
    if (hasTime) {
      return new Date(Date.UTC(d.y, d.m - 1, d.d, d.H, d.M, d.S));
    }
    // Date-only — construct at local noon so TZ math can't shift the day.
    return new Date(d.y, d.m - 1, d.d, 12, 0, 0);
  }
  if (typeof v === "string") {
    const parsed = new Date(v);
    if (Number.isNaN(parsed.getTime())) return undefined;
    return anchorDateOnlyToLocalNoon(parsed);
  }
  return undefined;
}

/**
 * If `d` represents UTC midnight (year/month/day in UTC with h=0 m=0
 * s=0 ms=0), return a new Date at the same Y/M/D LOCAL noon. Otherwise
 * pass through.
 *
 * Exported for unit-test reach so the TZ behavior is pinned.
 */
export function anchorDateOnlyToLocalNoon(d: Date): Date {
  const isUtcMidnight =
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0;
  if (!isUtcMidnight) return d;
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0);
}

/**
 * Parse a threaded-comment `dT` attribute as UTC. Excel + Google
 * Sheets emit these without a Z suffix (e.g. `2025-12-03T19:19:55.00`)
 * even though the underlying value is UTC — without the explicit
 * tz marker, `new Date(...)` interprets the string as local time,
 * which gives different results on the dev machine (ET) vs the prod
 * Docker container (UTC). Adding `Z` makes the interpretation
 * deterministic regardless of where the importer runs.
 *
 * Exported for unit-test reach.
 */
export function parseThreadedCommentDate(dt: string): Date {
  const normalized =
    dt.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dt) ? dt : `${dt.replace(/\.\d+$/, "")}Z`;
  return new Date(normalized);
}

function asString(v: unknown): string | undefined {
  if (v == null) return undefined;
  // Excel cells are typically string | number | boolean | Date; calling
  // String() on each is intentional.
  const raw = typeof v === "object" ? JSON.stringify(v) : `${v as string | number | boolean}`;
  const s = raw.trim();
  return s || undefined;
}

/**
 * Stable idempotency key for a row. SHA256(name + ordernoRaw +
 * sheet name), so the same row in the same sheet always produces
 * the same key across re-imports.
 *
 * Timestamp is intentionally NOT part of the key (it used to be,
 * pre-2026-05-27): when an operator corrects the row's Timestamp
 * cell and re-uploads, we WANT the importer to UPDATE the case in
 * place — not create a brand-new case with a different hash. So the
 * key carries only the "what" (customer + order + which sheet),
 * and the "when" lives on `ServiceCase.created` which is overwritten
 * on every re-import.
 *
 * Sheet name is included because a row may legitimately appear in
 * BOTH In Process AND Completed during a workflow move; those stay
 * as distinct cases until a future cross-sheet merge sweep.
 *
 * Trade-off: two genuinely-different cases for the same customer +
 * same order in the same sheet (e.g. the customer had a second
 * service event months later that the operator entered under the
 * same order #) will COLLAPSE into one case. In practice this is
 * rare; if it bites, the operator differentiates by editing one of
 * the rows' `Order #` cells to add a suffix.
 *
 * The signature still accepts `timestamp` so existing callers /
 * tests don't break, but the value is ignored.
 */
export function computeRowKey(args: {
  timestamp?: Date;
  name: string;
  ordernoRaw?: string;
  sheetName: string;
}): string {
  const parts = [
    (args.name || "").trim().toLowerCase(),
    (args.ordernoRaw || "").trim().toLowerCase(),
    args.sheetName.trim().toLowerCase(),
  ];
  const hash = createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 24);
  return `cs-sheet:${hash}`;
}

/**
 * Top-level entry point. Takes the raw .xlsx bytes and returns
 * normalized rows + threaded comments + person catalogue + warnings.
 */
export function parseSheetWorkbook(buffer: Buffer): ParsedWorkbook {
  const warnings: string[] = [];
  const zip = unzipSync(new Uint8Array(buffer));

  // Person catalogue (single file shared across sheets).
  let persons: PersonMap = new Map();
  const personFile = zip["xl/persons/person.xml"] ?? zip["xl/persons/personList.xml"];
  if (personFile) {
    try {
      persons = parsePersonXml(strFromU8(personFile));
    } catch (err) {
      warnings.push(`person.xml parse failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Map sheet-name → comments XML filename.
  const sheetIdxByName = buildSheetNameToIndex(zip);
  const commentFileByIdx = buildSheetCommentMap(zip);
  const sheetCommentFiles = new Map<string, string>();
  for (const [sheetName, sheetIdx] of sheetIdxByName.entries()) {
    const file = commentFileByIdx.get(sheetIdx);
    if (file) sheetCommentFiles.set(sheetName, file);
  }

  // Use sheetjs for the cell data (it handles shared-strings, types).
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });

  const rows: SheetRow[] = [];
  for (const sheetName of SHEETS_TO_IMPORT) {
    rows.push(...processSheet(wb, sheetName, sheetCommentFiles, zip, warnings));
  }

  return { rows, persons, sheetCommentFiles, warnings };
}

interface ColumnIndices {
  timestamp: number;
  name: number;
  phone: number;
  email: number;
  preferredContact: number;
  vendor: number;
  statusText: number;
  ordernoRaw: number;
  itemno: number;
  designer: number;
  initialIssue: number;
}

function buildColumnIndices(headers: string[]): ColumnIndices {
  const idx: ColumnIndices = {
    timestamp: findHeaderColumn(headers, HEADER_ALIASES.timestamp),
    name: findHeaderColumn(headers, HEADER_ALIASES.name),
    phone: findHeaderColumn(headers, HEADER_ALIASES.phone),
    email: findHeaderColumn(headers, HEADER_ALIASES.email),
    preferredContact: findHeaderColumn(headers, HEADER_ALIASES.preferredContact),
    vendor: findHeaderColumn(headers, HEADER_ALIASES.vendor),
    statusText: findHeaderColumn(headers, HEADER_ALIASES.statusText),
    ordernoRaw: findHeaderColumn(headers, HEADER_ALIASES.ordernoRaw),
    itemno: findHeaderColumn(headers, HEADER_ALIASES.itemno),
    designer: findHeaderColumn(headers, HEADER_ALIASES.designer),
    initialIssue: findHeaderColumn(headers, HEADER_ALIASES.initialIssue),
  };
  // Header row in 'C.S. In process' is corrupted — cell A1 is a
  // policy memo about mattress reselection rather than column
  // headers. Fall back to the fixed positions the form generator
  // always emits (`Form Responses 1` confirms the canonical layout):
  //   A=Timestamp, B=Client Name, ..., F=Vendor, G=Status,
  //   H=Order #, I=Item #, J=Designer, K=Initial Issue.
  // coerceDate / asString gracefully return undefined when the
  // fallback hits a row that doesn't actually have data in that
  // position, so this is safe to apply unconditionally.
  if (idx.timestamp < 0) idx.timestamp = 0;
  if (idx.name < 0) idx.name = 1;
  if (idx.phone < 0) idx.phone = 2;
  if (idx.email < 0) idx.email = 3;
  if (idx.preferredContact < 0) idx.preferredContact = 4;
  if (idx.vendor < 0) idx.vendor = 5;
  if (idx.statusText < 0) idx.statusText = 6;
  if (idx.ordernoRaw < 0) idx.ordernoRaw = 7;
  if (idx.itemno < 0) idx.itemno = 8;
  if (idx.designer < 0) idx.designer = 9;
  if (idx.initialIssue < 0) idx.initialIssue = 10;
  return idx;
}

function loadSheetCommentsByRef(
  sheetName: string,
  sheetCommentFiles: Map<string, string>,
  zip: Record<string, Uint8Array>,
  warnings: string[],
): Map<string, ThreadedComment[]> {
  const tcFile = sheetCommentFiles.get(sheetName);
  const out = new Map<string, ThreadedComment[]>();
  if (!tcFile || !zip[tcFile]) return out;

  let sheetComments: ThreadedComment[];
  try {
    sheetComments = parseThreadedCommentXml(strFromU8(zip[tcFile]));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`threaded comments for ${sheetName} parse failed: ${msg}`);
    return out;
  }
  for (const c of sheetComments) {
    const arr = out.get(c.ref) ?? [];
    arr.push(c);
    out.set(c.ref, arr);
  }
  return out;
}

function buildSheetRow(
  arr: unknown[],
  idx: ColumnIndices,
  sheetName: string,
  rowNumber: number,
  commentsByRef: Map<string, ThreadedComment[]>,
): SheetRow | null {
  const name = asString(arr[idx.name]);
  if (!name) return null;

  const timestamp = idx.timestamp >= 0 ? coerceDate(arr[idx.timestamp]) : undefined;
  const ordernoRaw = idx.ordernoRaw >= 0 ? asString(arr[idx.ordernoRaw]) : undefined;
  const rowKey = computeRowKey({ timestamp, name, ordernoRaw, sheetName });

  // The "notes" cell holds the row's threaded comments. Resolve its
  // column letter from initialIssue's index (usually 10 → "K") using
  // codePointAt/fromCodePoint (Sonar S7758 vs the legacy char-code
  // pair).
  const aCodePoint = "A".codePointAt(0) ?? 65;
  const cellCol = String.fromCodePoint(aCodePoint + idx.initialIssue);
  const cellRef = `${cellCol}${rowNumber}`;
  const rowComments = (commentsByRef.get(cellRef) ?? [])
    .slice()
    .sort((a, b) => a.dt.localeCompare(b.dt));

  return {
    sheetName,
    rowNumber,
    rowKey,
    timestamp,
    name,
    phone: idx.phone >= 0 ? asString(arr[idx.phone]) : undefined,
    email: idx.email >= 0 ? asString(arr[idx.email]) : undefined,
    preferredContact: idx.preferredContact >= 0 ? asString(arr[idx.preferredContact]) : undefined,
    vendor: idx.vendor >= 0 ? asString(arr[idx.vendor]) : undefined,
    statusText: idx.statusText >= 0 ? asString(arr[idx.statusText]) : undefined,
    ordernoRaw,
    itemno: idx.itemno >= 0 ? asString(arr[idx.itemno]) : undefined,
    designer: idx.designer >= 0 ? asString(arr[idx.designer]) : undefined,
    initialIssue: idx.initialIssue >= 0 ? asString(arr[idx.initialIssue]) : undefined,
    comments: rowComments,
  };
}

function processSheet(
  wb: XLSX.WorkBook,
  sheetName: string,
  sheetCommentFiles: Map<string, string>,
  zip: Record<string, Uint8Array>,
  warnings: string[],
): SheetRow[] {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];

  // Pull all rows as an array-of-arrays so we can ignore the corrupted
  // header in 'C.S. In process'. `raw: true` is critical for dates —
  // with `raw: false`, sheetjs returns date cells as pre-formatted
  // strings (e.g. "10/2/25") that already reflect the local TZ at
  // FORMATTING time, which means a UTC-midnight cell displays as the
  // PREVIOUS day in any timezone west of UTC. Keeping raw + cellDates
  // means dates come back as Date objects that coerceDate() can
  // anchor properly.
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    blankrows: false,
  });
  if (aoa.length < 2) return [];

  const headers = aoa[0].map((h) => {
    // Excel headers come back as string | number | Date | undefined.
    // Explicit branching to avoid `String(object)` → "[object Object]"
    // surprises when a future export embeds rich values in row 1.
    if (h == null) return "";
    if (typeof h === "string") return h.trim();
    if (typeof h === "number" || typeof h === "boolean") return `${h}`;
    return JSON.stringify(h);
  });
  const idx = buildColumnIndices(headers);
  const commentsByRef = loadSheetCommentsByRef(sheetName, sheetCommentFiles, zip, warnings);

  const out: SheetRow[] = [];
  for (let r = 1; r < aoa.length; r++) {
    // rowNumber is 1-indexed at the sheet level. aoa[0] is the header
    // row (sheet row 1); aoa[r] is sheet row r+1.
    const row = buildSheetRow(aoa[r], idx, sheetName, r + 1, commentsByRef);
    if (row) out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * Pure mapper from raw Excel status text to ServiceCaseStatus.name.
 * The orchestrator looks up the matching ServiceCaseStatus row by
 * name; this function does the text→name translation.
 *
 * Sheet values observed: "Service Call", "Needs Attention",
 * "Replacement on Order", "Completed", blank.
 */
export function mapExcelStatusName(raw: string | undefined, sheetName: string): string {
  // Completed sheet is uniformly closed — the cell value may be
  // "Completed" or blank, either way the case is closed.
  if (sheetName === "C.S. Completed") return "Completed";

  const v = (raw || "").trim().toLowerCase();
  if (!v) return "Open";
  if (v === "completed" || v === "closed" || v === "done") return "Completed";
  if (v === "service call") return "Service Call";
  if (v === "needs attention") return "Needs Attention";
  if (v === "replacement on order" || v === "ordered" || v === "waiting on vendor") {
    return "Waiting on Vendor";
  }
  if (v === "waiting on customer") return "Waiting on Customer";
  if (v === "waiting on parts") return "Waiting on Parts";
  if (v === "scheduled") return "Scheduled";
  if (v === "in progress") return "In Progress";
  if (v === "cancelled" || v === "canceled") return "Cancelled";
  // Fallback — operator can reclassify in the UI.
  return "Open";
}

// ---------------------------------------------------------------------------
// Sales-order token extraction
// ---------------------------------------------------------------------------

/**
 * Pattern for the order-no shapes that can appear in the "Order #" cell.
 * The cell often has multiple tokens mashed together (e.g.
 * "PONO6186 SO2986 Ack #249207"). We extract every sales-order-shaped
 * token and let the orchestrator try to match against SalesOrder.orderno.
 *
 * Generic shape: an alphabetic prefix (2+ letters) immediately followed
 * by 1-7 digits, with an optional rewrite suffix (" - A"). This matches
 * whatever order-number scheme a deployment uses without hardcoding any
 * store-specific prefixes. PO tokens (PON/PONO) are excluded here and
 * handled by extractPoTokens below. The orchestrator fails the lookup
 * and surfaces the row as unmatched for any token that isn't a real
 * order, which is the desired behavior.
 */
const SALES_ORDER_PATTERNS: RegExp[] = [/\b([A-Z]{2,5}\d{1,7}(?:\s*-\s*[A-Z])?)\b/gi];

// PO-token prefixes to exclude from sales-order extraction (they're
// matched separately by extractPoTokens). Keeps a "PONO6186" cell token
// from being mistaken for a sales order.
const PO_PREFIX_RE = /^PONO?\d/i;

/**
 * Extract every sales-order token from a raw cell value. Normalizes
 * spacing in rewrite suffixes ("SO-12345 -A" → "SO-12345 - A") to
 * match `SalesOrder.orderno` convention.
 */
export function extractSalesOrderTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  const upper = raw.toUpperCase();
  for (const pat of SALES_ORDER_PATTERNS) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(upper))) {
      // Skip PO tokens (PON/PONO...) — they're extracted separately and
      // would otherwise be mis-captured by the generic order pattern.
      if (PO_PREFIX_RE.test(m[1])) continue;
      const tok = m[1].replaceAll(/\s*-\s*([A-Z])$/g, " - $1");
      out.add(tok);
    }
  }
  return Array.from(out);
}

/**
 * PO-number tokens (PONO12345 / PON12345 / PON012345). the POS's
 * canonical shape on `PurchaseOrder.poNumber` is `PON` + 5-digit
 * zero-padded number; the spreadsheet variably uses `PONO12345`
 * (no zero pad) or `PON04217` (5-digit pad). The matcher normalizes
 * all variants to the canonical 5-digit form before lookup.
 */
const PO_PATTERNS: RegExp[] = [/\b(PONO\d{1,6})\b/gi, /\b(PON\d{1,6})\b/gi];

export function extractPoTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  const upper = raw.toUpperCase();
  for (const pat of PO_PATTERNS) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(upper))) out.add(m[1]);
  }
  return Array.from(out);
}

/**
 * Expand a raw PO token (`PONO6186`, `PON6186`, `PON04217`) into the
 * candidate `PurchaseOrder.poNumber` strings worth trying in order.
 * Pure helper so the orchestrator stays DB-only.
 */
export function poNumberCandidates(token: string): string[] {
  const upper = token.toUpperCase();
  const numMatch = /^(?:PONO|PON)(\d{1,6})$/.exec(upper);
  if (!numMatch) return [];
  const num = numMatch[1];
  const candidates = new Set<string>();
  // Canonical the POS shape: `PON` + 5-digit zero pad
  candidates.add(`PON${num.padStart(5, "0")}`);
  // Exact token + plain stripped variants
  candidates.add(upper);
  candidates.add(`PON${num}`);
  candidates.add(`PONO${num}`);
  // 6-digit zero-pad as a defensive fallback (very rare)
  candidates.add(`PON${num.padStart(6, "0")}`);
  return Array.from(candidates);
}

// ---------------------------------------------------------------------------
// Phone normalization
// ---------------------------------------------------------------------------

export function normalizePhone(raw: string | undefined): string {
  if (!raw) return "";
  // Strip everything that isn't a digit. Strip the leading "1"
  // country code if present so 18605551234 and 8605551234 collapse.
  const digits = raw.replaceAll(/\D+/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

// ---------------------------------------------------------------------------
// Author resolution
// ---------------------------------------------------------------------------

/**
 * Pure helper: given a PersonInfo (from person.xml) and a staff
 * lookup map (built from StaffMember.email + displayName + aliases),
 * return the resolved staffMemberId + the canonical display name.
 *
 * Lookup priority:
 *   1. PersonInfo.userId or displayName that contains "@" → email match
 *   2. PersonInfo.displayName as-is → displayName/alias match
 *   3. Nothing matches → return null id + raw display name (gets
 *      preserved on ServiceCaseNote.authorDisplayName for UI render)
 */
export function resolveAuthor(
  person: PersonInfo | undefined,
  staffByEmail: Map<string, number>,
  staffByName: Map<string, number>,
): { authorId: number | null; authorDisplayName: string } {
  if (!person) return { authorId: null, authorDisplayName: "(unknown)" };
  const display = person.displayName.trim();
  const emailHint = (person.userId || (display.includes("@") ? display : "")).toLowerCase().trim();
  if (emailHint) {
    const id = staffByEmail.get(emailHint);
    if (id) return { authorId: id, authorDisplayName: display };
  }
  // Name match (case-insensitive)
  const id = staffByName.get(display.toLowerCase());
  if (id) return { authorId: id, authorDisplayName: display };
  return { authorId: null, authorDisplayName: display };
}

// ---------------------------------------------------------------------------
// Case-number generator
// ---------------------------------------------------------------------------

/**
 * Generate a deterministic-but-readable caseNumber for an imported
 * case. The native UI generates `CS-YYYY-NNNN` style numbers; here
 * we prefix with `CSI-` ("CS Imported") so the source is obvious at
 * a glance AND the namespace doesn't collide with native-created
 * cases. Uses the rowKey suffix for uniqueness.
 */
export function generateImportedCaseNumber(rowKey: string): string {
  const stripped = rowKey.startsWith("cs-sheet:") ? rowKey.slice("cs-sheet:".length) : rowKey;
  const tail = stripped.slice(0, 10).toUpperCase();
  return `CSI-${tail}`;
}
