// /app/src/lib/runServiceCaseSheetImport.ts
//
// Orchestrator for the Customer Service Sheet → ServiceCase importer.
//
// What it does, in order:
//
//   1. Parse the .xlsx buffer into normalized rows + threaded
//      comments + person catalogue via lib/serviceCaseSheetImport.ts
//   2. Build lookup caches (statusByName, typeByName, priorityByName,
//      vendorByName, staffByEmail, staffByName) — one query each, not
//      per row.
//   3. For each row: match Customer / SalesOrder / Vendor / Designer.
//      UPSERT the ServiceCase by externalSourceId (CREATE when the
//      key is new; UPDATE when it's seen before).
//   4. For each threaded comment on the row: UPSERT the
//      ServiceCaseNote by externalSourceId. Notes are insert-only —
//      we never overwrite an existing note even if the source text
//      changed (threaded comments in Excel are immutable once
//      posted; the GUID never reappears with different content).
//   5. Bump externalSourceLastSeen on every touched case so a future
//      sweep can identify cases that disappeared from the sheet.
//
// Dry-run mode performs everything except the writes — useful for
// "what would change?" confirmation before the operator commits.

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  parseSheetWorkbook,
  parseThreadedCommentDate,
  mapExcelStatusName,
  extractSalesOrderTokens,
  extractPoTokens,
  poNumberCandidates,
  normalizePhone,
  resolveAuthor,
  generateImportedCaseNumber,
  type SheetRow,
  type PersonMap,
} from "@/lib/serviceCaseSheetImport";
import { logError } from "@/lib/logger";

const EXTERNAL_SOURCE = "cs-sheet";
const NOTE_SOURCE_PREFIX = "cs-sheet-note:";

export interface ServiceCaseSheetImportResult {
  parsed: {
    rows: number;
    notes: number;
    warnings: string[];
  };
  casesCreated: number;
  casesUpdated: number;
  notesCreated: number;
  /**
   * Initial-issue notes that already existed and were re-synced
   * (date + text updated to match the latest spreadsheet value).
   * Threaded-comment notes are NEVER updated — they stay immutable.
   */
  notesUpdated: number;
  notesSkipped: number;
  unmatched: UnmatchedRow[];
  errors: string[];
  /** Total wall-clock duration. */
  elapsedMs: number;
  /** When dryRun=true, no DB writes happened. */
  dryRun: boolean;
}

export interface UnmatchedRow {
  rowKey: string;
  sheetName: string;
  rowNumber: number;
  name: string;
  ordernoRaw?: string;
  reason: string;
}

export interface ServiceCaseSheetImportOptions {
  dryRun?: boolean;
  /** Identity for createdBy / updatedBy audit fields. */
  createdBy?: string;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runServiceCaseSheetImport(
  buffer: Buffer,
  options: ServiceCaseSheetImportOptions = {},
): Promise<ServiceCaseSheetImportResult> {
  const t0 = Date.now();
  const { dryRun = false, createdBy = "cs-sheet-import" } = options;

  const result: ServiceCaseSheetImportResult = {
    parsed: { rows: 0, notes: 0, warnings: [] },
    casesCreated: 0,
    casesUpdated: 0,
    notesCreated: 0,
    notesUpdated: 0,
    notesSkipped: 0,
    unmatched: [],
    errors: [],
    elapsedMs: 0,
    dryRun,
  };

  let parsed;
  try {
    parsed = parseSheetWorkbook(buffer);
  } catch (err) {
    result.errors.push(`Workbook parse failed: ${err instanceof Error ? err.message : err}`);
    result.elapsedMs = Date.now() - t0;
    return result;
  }
  result.parsed.rows = parsed.rows.length;
  result.parsed.notes = parsed.rows.reduce((acc, r) => acc + r.comments.length, 0);
  result.parsed.warnings = parsed.warnings;

  if (parsed.rows.length === 0) {
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  const caches = await buildCaches();

  // The "Other" type + "Normal" priority are the defaults for imported
  // rows — operators can reclassify in the UI. Look these up once.
  const defaultTypeId = caches.typeByName.get("other") ?? caches.firstTypeId;
  const defaultPriorityId = caches.priorityByName.get("normal") ?? caches.firstPriorityId;
  if (!defaultTypeId || !defaultPriorityId) {
    result.errors.push(
      "Missing default ServiceCaseType ('Other') or ServiceCasePriority ('Normal'). Seed those first.",
    );
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  for (const row of parsed.rows) {
    try {
      await processOneRow(
        row,
        parsed.persons,
        caches,
        {
          dryRun,
          createdBy,
          defaultTypeId,
          defaultPriorityId,
        },
        result,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`[${row.sheetName}!${row.rowNumber} ${row.name}]: ${msg}`);
      logError("service-case-sheet-import row failed", err);
    }
  }

  result.elapsedMs = Date.now() - t0;
  return result;
}

// ---------------------------------------------------------------------------
// Caches — one round-trip per lookup table
// ---------------------------------------------------------------------------

interface Caches {
  statusByName: Map<string, number>; // lowercase name → id
  typeByName: Map<string, number>;
  priorityByName: Map<string, number>;
  firstTypeId?: number;
  firstPriorityId?: number;
  vendorByName: Map<string, number>; // lowercase name → id
  staffByEmail: Map<string, number>; // lowercase email → StaffMember.id
  staffByName: Map<string, number>; // lowercase displayName/alias → StaffMember.id
  staffByFirstName: Map<string, number[]>; // for designer-by-first-name; multi-value
}

interface StaffIndex {
  staffByEmail: Map<string, number>;
  staffByName: Map<string, number>;
  staffByFirstName: Map<string, number[]>;
}

interface StaffRow {
  id: number;
  displayName: string;
  email: string | null;
  aliases: string[];
}

function addFirstNameEntry(map: Map<string, number[]>, source: string, id: number): void {
  const first = source.split(/\s+/)[0]?.toLowerCase();
  if (!first) return;
  const arr = map.get(first) ?? [];
  if (!arr.includes(id)) arr.push(id);
  map.set(first, arr);
}

function indexStaff(staff: StaffRow[]): StaffIndex {
  const staffByEmail = new Map<string, number>();
  const staffByName = new Map<string, number>();
  const staffByFirstName = new Map<string, number[]>();

  for (const s of staff) {
    if (s.email) staffByEmail.set(s.email.toLowerCase(), s.id);
    if (s.displayName) {
      staffByName.set(s.displayName.toLowerCase(), s.id);
      addFirstNameEntry(staffByFirstName, s.displayName, s.id);
    }
    for (const alias of s.aliases ?? []) {
      if (!alias) continue;
      staffByName.set(alias.toLowerCase(), s.id);
      addFirstNameEntry(staffByFirstName, alias, s.id);
    }
  }

  return { staffByEmail, staffByName, staffByFirstName };
}

async function buildCaches(): Promise<Caches> {
  const [statuses, types, priorities, vendors, staff] = await Promise.all([
    prisma.serviceCaseStatus.findMany({ select: { id: true, name: true } }),
    prisma.serviceCaseType.findMany({ select: { id: true, name: true } }),
    prisma.serviceCasePriority.findMany({ select: { id: true, name: true } }),
    prisma.vendor.findMany({ select: { id: true, name: true } }),
    prisma.staffMember.findMany({
      select: { id: true, displayName: true, email: true, aliases: true },
    }),
  ]);

  const staffIndex = indexStaff(staff);

  return {
    statusByName: new Map(statuses.map((s) => [s.name.toLowerCase(), s.id])),
    typeByName: new Map(types.map((t) => [t.name.toLowerCase(), t.id])),
    priorityByName: new Map(priorities.map((p) => [p.name.toLowerCase(), p.id])),
    firstTypeId: types[0]?.id,
    firstPriorityId: priorities[0]?.id,
    vendorByName: new Map(vendors.map((v) => [v.name.toLowerCase(), v.id])),
    ...staffIndex,
  };
}

// ---------------------------------------------------------------------------
// Matchers
// ---------------------------------------------------------------------------

async function matchCustomer(row: SheetRow): Promise<number | null> {
  // 1. Phone (digits-only) is the most stable
  const phoneDigits = normalizePhone(row.phone);
  if (phoneDigits && phoneDigits.length >= 7) {
    // Customer.phone is a free-form string; the trailing 7 digits
    // are enough to match against numbers stored with various
    // formatting (parens, dashes, dots).
    const tail = phoneDigits.slice(-7);
    const byPhone = await prisma.customer.findFirst({
      where: { phone: { contains: tail } },
      select: { id: true },
    });
    if (byPhone) return byPhone.id;
  }
  // 2. Email
  if (row.email) {
    const byEmail = await prisma.customer.findFirst({
      where: { email: { equals: row.email, mode: "insensitive" } },
      select: { id: true },
    });
    if (byEmail) return byEmail.id;
  }
  // 3. Last-name token + first-name fuzzy
  const parts = row.name.split(/[\s/]+/).filter(Boolean);
  if (parts.length >= 2) {
    const last = (parts.at(-1) ?? "").replaceAll(/[^a-zA-Z\-']/g, "");
    const first = parts[0].replaceAll(/[^a-zA-Z\-']/g, "");
    if (last.length >= 3) {
      const byName = await prisma.customer.findFirst({
        where: {
          lastName: { equals: last, mode: "insensitive" },
          firstName: { startsWith: first.slice(0, 4), mode: "insensitive" },
        },
        select: { id: true },
      });
      if (byName) return byName.id;
    }
  }
  return null;
}

/**
 * Resolve a sales-order FK from the raw "Order #" cell. Returns the
 * `SalesOrder.id` AND its `customerId` so the caller can use the
 * latter as a customer-fallback when phone/email/name matching fails.
 * Tries exact orderno + rewrite-base (strips " - A" suffix).
 */
async function matchSalesOrder(
  ordernoRaw: string | undefined,
): Promise<{ id: number; customerId: number | null } | null> {
  if (!ordernoRaw) return null;
  const tokens = extractSalesOrderTokens(ordernoRaw);
  for (const tok of tokens) {
    const exact = await prisma.salesOrder.findUnique({
      where: { orderno: tok },
      select: { id: true, customerId: true },
    });
    if (exact) return exact;
    const base = tok.replaceAll(/\s*-\s*[A-Z]$/g, "").trim();
    if (base !== tok) {
      const baseHit = await prisma.salesOrder.findUnique({
        where: { orderno: base },
        select: { id: true, customerId: true },
      });
      if (baseHit) return baseHit;
    }
  }
  return null;
}

/**
 * Resolve a PurchaseOrder FK from the raw "Order #" cell. The sheet
 * uses `PONO6186` / `PON04217` shapes; the POS system stores them as
 * `PON` + 5-digit zero-padded. poNumberCandidates() expands every
 * variant. Returns the first hit.
 */
async function matchPurchaseOrder(ordernoRaw: string | undefined): Promise<number | null> {
  if (!ordernoRaw) return null;
  const tokens = extractPoTokens(ordernoRaw);
  for (const tok of tokens) {
    for (const candidate of poNumberCandidates(tok)) {
      const hit = await prisma.purchaseOrder.findUnique({
        where: { poNumber: candidate },
        select: { id: true },
      });
      if (hit) return hit.id;
    }
  }
  return null;
}

function matchVendor(name: string | undefined, cache: Map<string, number>): number | null {
  if (!name) return null;
  const key = name.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  // Common abbreviations seen in the sheet
  const abbrev: Record<string, string> = {
    by: "bradington young",
    "bradington & young": "bradington young",
    al: "american leather",
    crl: "cr laine",
    "cr laine furniture": "cr laine",
    wh: "wesley hall",
  };
  const expanded = abbrev[key];
  if (expanded && cache.has(expanded)) return cache.get(expanded)!;
  // Fuzzy: any vendor name that starts with the cell value
  for (const [vname, id] of cache.entries()) {
    if (vname.startsWith(key) || key.startsWith(vname)) return id;
  }
  return null;
}

function matchDesigner(name: string | undefined, caches: Caches): number | null {
  if (!name) return null;
  const v = name.trim().toLowerCase();
  // 1. Try full match against displayName / aliases
  const direct = caches.staffByName.get(v);
  if (direct) return direct;
  // 2. First name (single match wins; multi-match returns null — operator must reclassify)
  const candidates = caches.staffByFirstName.get(v);
  if (candidates?.length === 1) return candidates[0];
  // 3. "Kim D" → match "Kim D" alias or "Kim Dransfield" displayName-prefix
  const collapsed = v.replaceAll(/\s+/g, " ");
  for (const [k, id] of caches.staffByName.entries()) {
    if (k.startsWith(collapsed) || collapsed.startsWith(k)) return id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row processor — one row → one case (+ N notes)
// ---------------------------------------------------------------------------

interface ProcessOptions {
  dryRun: boolean;
  createdBy: string;
  defaultTypeId: number;
  defaultPriorityId: number;
}

interface PendingNote {
  externalSourceId: string;
  note: string;
  created: Date;
  authorId: number | null;
  authorDisplayName: string;
}

function pushUnmatched(result: ServiceCaseSheetImportResult, row: SheetRow, reason: string): void {
  result.unmatched.push({
    rowKey: row.rowKey,
    sheetName: row.sheetName,
    rowNumber: row.rowNumber,
    name: row.name,
    ordernoRaw: row.ordernoRaw,
    reason,
  });
}

function buildPendingNotes(
  row: SheetRow,
  persons: PersonMap,
  caches: Caches,
  _fallbackTimestamp: Date,
): PendingNote[] {
  const out: PendingNote[] = [];

  // Pre-resolve each threaded comment's date so we don't parse the
  // same `dT` twice (once for the note, once for the case-opened
  // fallback in upsertCase).
  const commentEntries = row.comments.map((c) => ({
    comment: c,
    created: parseThreadedCommentDate(c.dt),
  }));
  const earliestThreaded =
    commentEntries.length > 0
      ? commentEntries.reduce(
          (min, e) => (e.created.getTime() < min.getTime() ? e.created : min),
          commentEntries[0].created,
        )
      : undefined;

  // Date precedence for the initial-issue note (must match `upsertCase`'s
  // openedAt precedence so the note date and the case-opened date
  // stay in sync):
  //   1. The earliest threaded comment date — the actual first activity
  //      on the case, and (per owner direction 2026-05-27) the source
  //      of truth that the Timestamp cell can't beat. Many spreadsheet
  //      rows have wrong / typo'd Timestamp values; the comment dates
  //      come from Excel's threaded-comment GUIDs and are reliable.
  //   2. The row's Timestamp / Start Date cell — used only when the
  //      row has no comments.
  //
  // If NEITHER is known (the Repair sheet has no Timestamp column and
  // many In-Process rows are blank), we deliberately SKIP creating
  // the initial-issue note. Stamping it with `now()` was misleading —
  // user-reported 2026-05-27: "the initial date for the comments is
  // showing today's date for a lot if not all the imported services."
  // The initial-issue TEXT is preserved on the case's `summary` field
  // (set in processOneRow), so no information is lost — we just don't
  // fabricate a date we don't actually know.
  const initialNoteCreated = earliestThreaded ?? row.timestamp;
  if (row.initialIssue && initialNoteCreated) {
    out.push({
      externalSourceId: `${NOTE_SOURCE_PREFIX}initial:${row.rowKey}`,
      note: row.initialIssue,
      created: initialNoteCreated,
      authorId: null,
      authorDisplayName: "(initial)",
    });
  }
  for (const entry of commentEntries) {
    const author = resolveAuthor(
      persons.get(entry.comment.personId),
      caches.staffByEmail,
      caches.staffByName,
    );
    out.push({
      externalSourceId: threadedNoteKey(row.rowKey, entry.comment.text, entry.created),
      note: entry.comment.text,
      created: entry.created,
      authorId: author.authorId,
      authorDisplayName: author.authorDisplayName,
    });
  }
  return out;
}

/**
 * Stable, content-based externalSourceId for a threaded comment.
 *
 * Originally we keyed on the comment's GUID from
 * `xl/threadedComments/threadedCommentN.xml` because Excel's native
 * authoring guarantees a stable globally-unique id per comment. The
 * Customer Service Sheet, however, lives in Google Sheets and the
 * operator exports it as .xlsx every time — and Google Sheets
 * REGENERATES the threaded-comment GUIDs on every export. Result:
 * every re-import landed the same physical comment under a NEW
 * externalSourceId, so dedup never fired and notes accumulated 2-3
 * deep per case (audit against 2026-05-28 backup: 1,780 dup
 * groups / 5,268 dup rows across cs-sheet-sourced notes).
 *
 * The content-based key — sha256(rowKey + day + text) prefixed with
 * `cs-sheet-note:content:` — collapses re-imports of the same
 * (case row, calendar day, comment text) to a single note even when
 * the source GUID churns. Same-day edits that change the text get a
 * new key (treated as a separate comment, intentional). Different-
 * day re-imports of identical text also get separate keys (rare,
 * but operator-intended if it happens).
 *
 * The day is normalized to `YYYY-MM-DD` in UTC so daylight-savings
 * shifts on the underlying `created` don't break the key. We
 * intentionally do NOT include hours/minutes — Google Sheets'
 * comment timestamp precision varies by export.
 */
export function threadedNoteKey(rowKey: string, text: string, created: Date): string {
  const day = `${created.getUTCFullYear()}-${String(created.getUTCMonth() + 1).padStart(2, "0")}-${String(created.getUTCDate()).padStart(2, "0")}`;
  const hash = createHash("sha256").update(`${rowKey}|${day}|${text}`).digest("hex").slice(0, 24);
  return `${NOTE_SOURCE_PREFIX}content:${hash}`;
}

async function upsertCase(
  row: SheetRow,
  baseData: Prisma.ServiceCaseUncheckedUpdateInput,
  opts: ProcessOptions,
  result: ServiceCaseSheetImportResult,
  now: Date,
): Promise<number | "dry-run-skip"> {
  // The case's `created` date is the user-visible "Opened" date in
  // the UI. Date precedence (revised 2026-05-27 per owner feedback —
  // "the open date should be the same as the earliest date in the
  // comments"):
  //   1. earliest threaded comment — the actual first activity on the
  //      case, and the operator's source of truth. Wins over the
  //      Timestamp cell because the spreadsheet's Timestamp column
  //      has wrong / typo'd values for many rows (e.g. row with
  //      Timestamp=2026-12-31 but real first comment Jan 2026).
  //   2. row.timestamp — the operator's explicit "Start Date" cell.
  //      Used only when no comments exist to give us a real signal.
  //   3. `now` — last resort. Cases with neither a comment NOR a
  //      Timestamp cell genuinely have no historical date to anchor
  //      to; the UI shows today.
  //
  // We compute this OUTSIDE the create-vs-update branch and apply
  // it to BOTH paths so a re-import correctly overwrites old wrong
  // values. Native ERP-created cases never enter this path because
  // they don't carry an externalSourceId.
  const openedAt = earliestCommentDate(row) ?? row.timestamp ?? now;
  const dataWithCreated = { ...baseData, created: openedAt };

  // Look up the case by its current rowKey first (fast path). If that
  // misses, fall back to a content-based match — same customer + same
  // order + same summary text on a cs-sheet case. The fallback catches
  // re-imports across rowKey schema changes (PR #331 hashed the
  // Timestamp cell; PR #335 dropped it; without this guard a fresh run
  // creates brand-new cases for every row even though they already
  // exist). When the fallback hits, we UPDATE the case's
  // externalSourceId to the new rowKey so the next import takes the
  // fast path again.
  let existing = await findExistingCase(row, baseData);

  if (existing) {
    if (!opts.dryRun) {
      const updatePayload =
        existing.externalSourceId === row.rowKey
          ? dataWithCreated
          : { ...dataWithCreated, externalSourceId: row.rowKey };
      await prisma.serviceCase.update({ where: { id: existing.id }, data: updatePayload });
    }
    result.casesUpdated += 1;
    return existing.id;
  }

  if (opts.dryRun) {
    // Skip the actual create + note writes; count what WOULD happen.
    result.casesCreated += 1;
    result.notesCreated += row.comments.length + (row.initialIssue ? 1 : 0);
    return "dry-run-skip";
  }

  const created = await prisma.serviceCase.create({
    data: {
      ...(dataWithCreated as Prisma.ServiceCaseUncheckedCreateInput),
      caseNumber: generateImportedCaseNumber(row.rowKey),
      typeId: opts.defaultTypeId,
      priorityId: opts.defaultPriorityId,
      createdBy: opts.createdBy,
    },
  });
  result.casesCreated += 1;
  return created.id;
}

function earliestCommentDate(row: SheetRow): Date | undefined {
  if (row.comments.length === 0) return undefined;
  let earliest = parseThreadedCommentDate(row.comments[0].dt);
  for (let i = 1; i < row.comments.length; i++) {
    const d = parseThreadedCommentDate(row.comments[i].dt);
    if (d.getTime() < earliest.getTime()) earliest = d;
  }
  return earliest;
}

/**
 * Date of the most recent threaded comment on this row. Used to
 * approximate `resolvedAt` for cases that landed on the Completed
 * sheet — the last comment is, in practice, the closing comment.
 */
function latestCommentDate(row: SheetRow): Date | undefined {
  if (row.comments.length === 0) return undefined;
  let latest = parseThreadedCommentDate(row.comments[0].dt);
  for (let i = 1; i < row.comments.length; i++) {
    const d = parseThreadedCommentDate(row.comments[i].dt);
    if (d.getTime() > latest.getTime()) latest = d;
  }
  return latest;
}

const MAX_RESOLUTION_DAYS = 1825; // 5 years; bounds Excel-epoch artifacts
const MS_PER_DAY = 86_400_000;

/**
 * Compute the case's `resolvedAt` from row signals, sanity-bounded
 * against the case's effective open date.
 *
 * Returns `null` when:
 *   - the row's status isn't Completed
 *   - we have no signal for "when was this resolved"
 *   - the implied (resolvedAt − openedAt) duration is negative or
 *     longer than 5 years (Excel-epoch garbage check)
 *
 * Extracted from `processOneRow` so the surrounding function stays
 * below the Sonar S3776 cog-complexity threshold + so the rule
 * itself is unit-testable.
 */
function computeResolvedAt(row: SheetRow, statusName: string, now: Date): Date | null {
  if (statusName.toLowerCase() !== "completed") return null;
  const candidate = latestCommentDate(row) ?? row.timestamp ?? null;
  if (!candidate) return null;
  const opened = earliestCommentDate(row) ?? row.timestamp ?? now;
  const durationMs = candidate.getTime() - opened.getTime();
  if (durationMs < 0) return null;
  if (durationMs > MAX_RESOLUTION_DAYS * MS_PER_DAY) return null;
  return candidate;
}

interface ExistingCaseHit {
  id: number;
  externalSourceId: string | null;
}

/**
 * Locate an existing cs-sheet case for this row. Two-step lookup —
 * fast path is the rowKey index, fallback is content-based
 * (customer + order + summary text). The fallback exists because
 * the rowKey computation changed shape mid-flight (PR #331 hashed
 * the Timestamp cell; PR #335 dropped it); without it, a re-import
 * after the schema change created brand-new case rows for every
 * physical sheet row. See `20260528b_merge_service_case_dupes` for
 * the recovery migration that cleaned up the existing dups.
 */
async function findExistingCase(
  row: SheetRow,
  baseData: Prisma.ServiceCaseUncheckedUpdateInput,
): Promise<ExistingCaseHit | null> {
  const byRowKey = await prisma.serviceCase.findUnique({
    where: { externalSourceId: row.rowKey },
    select: { id: true, externalSourceId: true },
  });
  if (byRowKey) return byRowKey;

  // Content-based fallback. Match on (customerId, salesOrderId,
  // itemDescription, lowercased summary prefix) — same key the
  // dedup migration uses. Require a non-empty summary so blank rows
  // don't all collapse into one match.
  const summaryRaw = typeof baseData.summary === "string" ? baseData.summary : "";
  const summaryKey = summaryRaw.trim().slice(0, 80).toLowerCase();
  if (!summaryKey) return null;

  const candidates = await prisma.serviceCase.findMany({
    where: {
      externalSource: "cs-sheet",
      customerId: (baseData.customerId as number | null | undefined) ?? null,
      salesOrderId: (baseData.salesOrderId as number | null | undefined) ?? null,
      itemDescription:
        typeof baseData.itemDescription === "string" ? baseData.itemDescription : null,
    },
    select: { id: true, externalSourceId: true, summary: true },
    take: 25,
  });
  const hit = candidates.find(
    (c) => (c.summary ?? "").trim().slice(0, 80).toLowerCase() === summaryKey,
  );
  return hit ? { id: hit.id, externalSourceId: hit.externalSourceId } : null;
}

/**
 * Note ExternalSourceId prefix for the synthetic "initial issue"
 * note (one per row). Threaded-comment notes use `cs-sheet-note:`
 * + the comment GUID — those keep the immutable contract because
 * Excel never reassigns a comment GUID. The synthetic initial note
 * is the only re-syncable note, since its date + text come from
 * cells the operator can correct in the sheet.
 */
const INITIAL_NOTE_PREFIX = "cs-sheet-note:initial:";

function isInitialNote(externalSourceId: string): boolean {
  return externalSourceId.startsWith(INITIAL_NOTE_PREFIX);
}

async function writeNotes(
  caseId: number,
  pendingNotes: PendingNote[],
  opts: ProcessOptions,
  result: ServiceCaseSheetImportResult,
): Promise<void> {
  if (pendingNotes.length === 0) return;

  const externalIds = pendingNotes.map((n) => n.externalSourceId);
  const existingNotes = await prisma.serviceCaseNote.findMany({
    where: { externalSourceId: { in: externalIds } },
    select: { externalSourceId: true },
  });
  const existingKeys = new Set(existingNotes.map((n) => n.externalSourceId));

  if (opts.dryRun) {
    for (const n of pendingNotes) {
      if (existingKeys.has(n.externalSourceId)) {
        if (isInitialNote(n.externalSourceId)) result.notesUpdated += 1;
        else result.notesSkipped += 1;
      } else {
        result.notesCreated += 1;
      }
    }
    return;
  }

  // ── Insert path: brand-new notes (both initial + threaded). ────
  const toInsert = pendingNotes.filter((n) => !existingKeys.has(n.externalSourceId));
  if (toInsert.length > 0) {
    const insertResult = await prisma.serviceCaseNote.createMany({
      data: toInsert.map((n) => ({
        caseId,
        authorId: n.authorId,
        authorDisplayName: n.authorDisplayName,
        note: n.note,
        isInternal: true,
        externalSource: EXTERNAL_SOURCE,
        externalSourceId: n.externalSourceId,
        created: n.created,
        createdBy: opts.createdBy,
      })),
      skipDuplicates: true,
    });
    result.notesCreated += insertResult.count;
  }

  // ── Update path: re-sync date + text on existing INITIAL notes. ─
  // Threaded comments stay immutable (their GUIDs are minted in the
  // sheet and never change content; the date the user sees should
  // match the comment's original posting time, not "today").
  const initialToUpdate = pendingNotes.filter(
    (n) => isInitialNote(n.externalSourceId) && existingKeys.has(n.externalSourceId),
  );
  for (const n of initialToUpdate) {
    await prisma.serviceCaseNote.update({
      where: { externalSourceId: n.externalSourceId },
      data: { note: n.note, created: n.created },
    });
  }
  result.notesUpdated += initialToUpdate.length;

  // Threaded notes that already existed = genuinely skipped (immutable).
  const threadedSkipped = pendingNotes.filter(
    (n) => !isInitialNote(n.externalSourceId) && existingKeys.has(n.externalSourceId),
  ).length;
  result.notesSkipped += threadedSkipped;
}

async function processOneRow(
  row: SheetRow,
  persons: PersonMap,
  caches: Caches,
  opts: ProcessOptions,
  result: ServiceCaseSheetImportResult,
): Promise<void> {
  const statusName = mapExcelStatusName(row.statusText, row.sheetName);
  const statusId = caches.statusByName.get(statusName.toLowerCase());
  if (!statusId) {
    pushUnmatched(result, row, `Status '${statusName}' not in ServiceCaseStatus`);
    return;
  }

  // Best-effort foreign-key matching. Order resolution happens first
  // because a matched SalesOrder gives us a customerId fallback for
  // rows where phone/email/name fail (couples, business names,
  // spelling variants). Empirical: 79% of order-bearing rows match
  // SOMETHING; matching customer-by-order lifts the customer match
  // rate close to that.
  const salesOrderMatch = await matchSalesOrder(row.ordernoRaw);
  const purchaseOrderId = await matchPurchaseOrder(row.ordernoRaw);
  const salesOrderId = salesOrderMatch?.id ?? null;
  const vendorId = matchVendor(row.vendor, caches.vendorByName);
  const salesPersonId = matchDesigner(row.designer, caches);

  let customerId = await matchCustomer(row);
  if (!customerId && salesOrderMatch?.customerId) {
    customerId = salesOrderMatch.customerId;
  }

  // Surface what specifically couldn't be matched. Cases still land
  // (FKs are nullable) — the unmatched list lets an operator fix the
  // sheet and re-import, or reconcile in the ERP directly.
  const hadOrderInCell = !!row.ordernoRaw?.trim();
  if (hadOrderInCell && !salesOrderId && !purchaseOrderId) {
    pushUnmatched(
      result,
      row,
      `Order # '${row.ordernoRaw}' didn't match any SalesOrder or PurchaseOrder`,
    );
  }
  if (!customerId) {
    pushUnmatched(
      result,
      row,
      hadOrderInCell
        ? "Customer not found by phone/email/name, and order didn't yield a customer"
        : "Customer not found by phone/email/name (no Order # to fall back on)",
    );
  }

  // First 200 chars of the initial issue (or a sensible fallback) make
  // the case's `summary` field — what the dispatch board shows.
  const summary = (row.initialIssue || row.statusText || `Imported case for ${row.name}`)
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, 200);

  const now = new Date();

  // For rows on the "Completed" sheet (or with an explicit
  // Completed status), set `resolvedAt` from the latest threaded
  // comment date. Sanity-bounded against the case's effective
  // open date to keep Excel-epoch garbage out of the KPI. See
  // `computeResolvedAt` for the precedence + bounds.
  const resolvedAt = computeResolvedAt(row, statusName, now);

  const baseData: Prisma.ServiceCaseUncheckedUpdateInput = {
    statusId,
    summary,
    customerId: customerId ?? null,
    salesOrderId,
    purchaseOrderId,
    vendorId: vendorId ?? null,
    salesPersonId: salesPersonId ?? null,
    preferredContact: row.preferredContact ?? null,
    itemDescription: row.itemno ?? null,
    resolvedAt,
    externalSource: EXTERNAL_SOURCE,
    externalSourceId: row.rowKey,
    externalSourceLastSeen: now,
    updatedBy: opts.createdBy,
  };

  const caseId = await upsertCase(row, baseData, opts, result, now);
  if (caseId === "dry-run-skip") return;

  const pendingNotes = buildPendingNotes(row, persons, caches, now);

  // If this row no longer has a real source date for its initial-issue
  // note (Repair sheet, blank-Timestamp rows with no comments), AND a
  // prior import landed an initial note for the same rowKey stamped
  // with `now`, that stale row is what's currently showing "today"
  // in the UI. Clean it up — the initial-issue TEXT is preserved on
  // the case's `summary`, so deleting the note loses nothing.
  const initialKey = `${NOTE_SOURCE_PREFIX}initial:${row.rowKey}`;
  const initialInPending = pendingNotes.some((n) => n.externalSourceId === initialKey);
  if (!initialInPending && !opts.dryRun) {
    const deleted = await prisma.serviceCaseNote.deleteMany({
      where: { externalSourceId: initialKey },
    });
    if (deleted.count > 0) {
      // Track as "updated" — operator sees the case re-touched on re-import.
      result.notesUpdated += deleted.count;
    }
  }

  await writeNotes(caseId, pendingNotes, opts, result);
}
