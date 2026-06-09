// /app/src/lib/buyerDraftRealPoLink.ts
//
// Pure helper that computes the empirical link between a Buy's
// buyer-draft items and real the POS PurchaseOrder rows, by joining
// on `BuyerDraftItem.fulfilledProductId === PurchaseOrderItem.productId`.
//
// Origin (2026-05-14): user gave us 20 real PON numbers for Spring
// 2026; ad-hoc SQL proved the productId join works empirically (74 of
// 80 drafts mapped, 4 draft POs cleanly spanned multiple real PONs,
// one cosmetic vendor mismatch surfaced). This file lifts that logic
// out of ad-hoc queries into a pure function so the same view ships
// on every Buy detail page — for the Spring 2026 backfill AND every
// future market write-up.
//
// Why this is empirical / read-only, not predictive: it joins on the
// link the buyer set at draft-time (via barcode-lookup, catalog
// picker, or slice 5 auto-link) — it does NOT try to infer matches
// for drafts with no `fulfilledProductId`. That's a feature, not a
// gap. If a draft isn't linked, we surface it under
// `unmatchedDrafts` so the buyer can investigate.
//
// 1:N relationships are first-class. Per user 2026-05-14:
// "I think I combined a couple into one on the draft" — one draft PO
// can map to multiple real POs (Bradington Young Spring 2026 example:
// draft PO 3 covered PON07054 + PON07576 + PON08313). The helper
// returns the full set per draft PO, not a single "best match."
//
// Pure I/O: no Prisma calls. The caller (the API endpoint) hydrates
// the input shapes from the DB. See
// `pages/api/admin/buyer-drafts/buys/[id]/linked-pos.ts`.

export interface DraftItemInput {
  id: number;
  partNumber: string;
  productName: string;
  vendorName: string;
  fulfilledProductId: number | null;
  draftPoId: number | null;
}

export interface DraftPoInput {
  id: number;
  vendorName: string;
}

export interface RealPoLineInput {
  realPoId: number;
  productId: number | null;
  orderedQuantity: number;
  // Slice 6.14.1 (2026-05-22) — surfaced on the UI when the operator
  // expands a linked PO row. Optional so older callers don't break.
  partNo?: string | null;
  productName?: string | null;
  unitCost?: number | null;
}

export interface RealPoInput {
  id: number;
  poNumber: string;
  vendor: string;
  vendorId: number | null;
  orderDate: Date | null;
  status: string;
}

export interface LinkedRealPoLineDetail {
  productId: number | null;
  partNo: string | null;
  productName: string | null;
  orderedQuantity: number;
  unitCost: number | null;
  /** True when this line's productId is in `idx.linkedProductIds` —
   *  i.e. the line is one the buyer drafted (stock match), not an
   *  unrelated frame variant or sticky-fee line. UI uses this to
   *  visually distinguish "in your plan" rows from "other items on
   *  this PON." */
  matchesDraft: boolean;
}

export interface LinkedRealPoSummary {
  id: number;
  poNumber: string;
  vendor: string;
  vendorId: number | null;
  orderDate: Date | null;
  status: string;
  /** Number of real-PO lines whose productId matches a linked draft item. */
  matchedLines: number;
  /** Total number of lines on the real PO. */
  totalLines: number;
  /** Sum of orderedQuantity on matched lines. */
  matchedQty: number;
  /** Sum of orderedQuantity on all lines of the real PO. */
  totalQty: number;
  /** Slice 6.14.1 — full line-item list for the expand-on-click UI.
   *  Always populated when the upstream RealPoLineInput includes the
   *  detail fields; an empty array means no items (rare). */
  lines: LinkedRealPoLineDetail[];
}

export interface DraftPoMappingSummary {
  draftPoId: number;
  vendorName: string;
  draftItemCount: number;
  /** PON numbers of real POs that contain at least one matching line. */
  linkedRealPoNumbers: string[];
}

export interface UnmatchedDraftItem {
  id: number;
  partNumber: string;
  productName: string;
  vendorName: string;
  /** Why this draft didn't match any real PO line.
   *  `no-link` = `fulfilledProductId` is null (buyer hasn't linked it
   *    to a catalog Product — happens for items that haven't been
   *    barcode-lookup'd / catalog-picker'd / slice-5-auto-linked).
   *  `not-on-any-real-po` = the Product is linked, but no real PO line
   *    references it (item planned but not yet entered into the POS,
   *    or the PO it's on isn't in our DB yet). */
  reason: "no-link" | "not-on-any-real-po";
}

export interface LinkedPosResult {
  totals: {
    draftItems: number;
    draftItemsLinked: number;
    draftPos: number;
    matchedRealPos: number;
    unmatchedDraftItems: number;
  };
  realPos: LinkedRealPoSummary[];
  draftPos: DraftPoMappingSummary[];
  unmatchedDrafts: UnmatchedDraftItem[];
}

interface IndexedInputs {
  linkedProductIds: Set<number>;
  linesByRealPoId: Map<number, RealPoLineInput[]>;
  realPoIdsByProductId: Map<number, Set<number>>;
  realPoById: Map<number, RealPoInput>;
}

function indexInputs(
  drafts: readonly DraftItemInput[],
  realPos: readonly RealPoInput[],
  realPoLines: readonly RealPoLineInput[],
): IndexedInputs {
  const linkedProductIds = new Set<number>();
  for (const d of drafts) {
    if (d.fulfilledProductId !== null) linkedProductIds.add(d.fulfilledProductId);
  }
  const linesByRealPoId = new Map<number, RealPoLineInput[]>();
  const realPoIdsByProductId = new Map<number, Set<number>>();
  for (const line of realPoLines) {
    const bucket = linesByRealPoId.get(line.realPoId) ?? [];
    bucket.push(line);
    linesByRealPoId.set(line.realPoId, bucket);
    if (line.productId !== null && linkedProductIds.has(line.productId)) {
      const set = realPoIdsByProductId.get(line.productId) ?? new Set<number>();
      set.add(line.realPoId);
      realPoIdsByProductId.set(line.productId, set);
    }
  }
  return {
    linkedProductIds,
    linesByRealPoId,
    realPoIdsByProductId,
    realPoById: new Map(realPos.map((p) => [p.id, p])),
  };
}

function compareRealPoSummary(a: LinkedRealPoSummary, b: LinkedRealPoSummary): number {
  if (a.vendor !== b.vendor) return a.vendor.localeCompare(b.vendor);
  const at = a.orderDate ? a.orderDate.getTime() : Number.POSITIVE_INFINITY;
  const bt = b.orderDate ? b.orderDate.getTime() : Number.POSITIVE_INFINITY;
  return at - bt;
}

function buildRealPoSummaries(idx: IndexedInputs): LinkedRealPoSummary[] {
  const matchedIds = new Set<number>();
  for (const ids of idx.realPoIdsByProductId.values()) {
    for (const id of ids) matchedIds.add(id);
  }
  const out: LinkedRealPoSummary[] = [];
  for (const realPoId of matchedIds) {
    const po = idx.realPoById.get(realPoId);
    if (!po) continue;
    const allLines = idx.linesByRealPoId.get(realPoId) ?? [];
    const matchedLines = allLines.filter(
      (l) => l.productId !== null && idx.linkedProductIds.has(l.productId),
    );
    out.push({
      id: po.id,
      poNumber: po.poNumber,
      vendor: po.vendor,
      vendorId: po.vendorId,
      orderDate: po.orderDate,
      status: po.status,
      matchedLines: matchedLines.length,
      totalLines: allLines.length,
      matchedQty: matchedLines.reduce((sum, l) => sum + l.orderedQuantity, 0),
      totalQty: allLines.reduce((sum, l) => sum + l.orderedQuantity, 0),
      lines: allLines.map((l) => ({
        productId: l.productId,
        partNo: l.partNo ?? null,
        productName: l.productName ?? null,
        orderedQuantity: l.orderedQuantity,
        unitCost: l.unitCost ?? null,
        matchesDraft: l.productId !== null && idx.linkedProductIds.has(l.productId),
      })),
    });
  }
  out.sort(compareRealPoSummary);
  return out;
}

function realPoNumbersForChildren(
  childDrafts: readonly DraftItemInput[],
  idx: IndexedInputs,
): string[] {
  const set = new Set<string>();
  for (const child of childDrafts) {
    if (child.fulfilledProductId === null) continue;
    const realIds = idx.realPoIdsByProductId.get(child.fulfilledProductId);
    if (!realIds) continue;
    for (const realPoId of realIds) {
      const realPo = idx.realPoById.get(realPoId);
      if (realPo) set.add(realPo.poNumber);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function buildDraftPoSummaries(
  drafts: readonly DraftItemInput[],
  draftPos: readonly DraftPoInput[],
  idx: IndexedInputs,
): DraftPoMappingSummary[] {
  const out: DraftPoMappingSummary[] = draftPos.map((draftPo) => {
    const childDrafts = drafts.filter((d) => d.draftPoId === draftPo.id);
    return {
      draftPoId: draftPo.id,
      vendorName: draftPo.vendorName,
      draftItemCount: childDrafts.length,
      linkedRealPoNumbers: realPoNumbersForChildren(childDrafts, idx),
    };
  });
  out.sort((a, b) => a.vendorName.localeCompare(b.vendorName));
  return out;
}

function buildUnmatchedDrafts(
  drafts: readonly DraftItemInput[],
  idx: IndexedInputs,
): UnmatchedDraftItem[] {
  const out: UnmatchedDraftItem[] = [];
  for (const d of drafts) {
    const reason = unmatchedReason(d, idx);
    if (reason === null) continue;
    out.push({
      id: d.id,
      partNumber: d.partNumber,
      productName: d.productName,
      vendorName: d.vendorName,
      reason,
    });
  }
  out.sort((a, b) => {
    if (a.vendorName !== b.vendorName) return a.vendorName.localeCompare(b.vendorName);
    return a.partNumber.localeCompare(b.partNumber);
  });
  return out;
}

function unmatchedReason(
  d: DraftItemInput,
  idx: IndexedInputs,
): UnmatchedDraftItem["reason"] | null {
  if (d.fulfilledProductId === null) return "no-link";
  if (!idx.realPoIdsByProductId.has(d.fulfilledProductId)) return "not-on-any-real-po";
  return null;
}

/**
 * Optional scoping inputs that narrow the empirical productId join to a
 * sensible set of real POs. Added 2026-05-22 after the Spring 2026 audit
 * found the all-time join surfacing 72 PONs spanning April 2023 through
 * May 2026 — including stocking-item PONs from 2-3 years before the buy.
 *
 * Two scoping mechanisms:
 *   - `explicitRealPoIds`: if the Buy has any draft POs with
 *     `importedFromPurchaseOrderId` set (Slice 6.13 historical imports),
 *     pass the set here. The result becomes EXACTLY those PONs — the
 *     empirical join is skipped. This is the buyer's authoritative
 *     "this is what's in my buy" statement and overrides the heuristic.
 *   - `windowStart`: when no explicit set is provided, real POs whose
 *     `orderDate` is before `windowStart` are filtered out. Typical
 *     caller: earliest draft `expectedShipMonth` minus 6 months
 *     (catches October-market writeups for Spring ETAs without
 *     surfacing 2-year-old stocking history).
 *
 * Both knobs are optional. When neither is supplied the helper behaves
 * exactly as it did pre-2026-05-22 (all-time empirical join).
 */
export interface LinkedPosScope {
  explicitRealPoIds?: ReadonlySet<number>;
  windowStart?: Date | null;
}

export function computeLinkedPos(
  drafts: readonly DraftItemInput[],
  draftPos: readonly DraftPoInput[],
  realPos: readonly RealPoInput[],
  realPoLines: readonly RealPoLineInput[],
  scope: LinkedPosScope = {},
): LinkedPosResult {
  // Apply the scope BEFORE indexing so the unmatched-draft logic only
  // considers scoped real POs (a draft item linked to a Product that
  // only appears on out-of-window POs counts as `not-on-any-real-po`).
  const scopedRealPos = filterRealPos(realPos, scope);
  const scopedRealPoLines = filterRealPoLines(realPoLines, scopedRealPos);

  const idx = indexInputs(drafts, scopedRealPos, scopedRealPoLines);
  const realPoSummaries = buildRealPoSummaries(idx);
  const draftPoSummaries = buildDraftPoSummaries(drafts, draftPos, idx);
  const unmatchedDrafts = buildUnmatchedDrafts(drafts, idx);
  return {
    totals: {
      draftItems: drafts.length,
      draftItemsLinked: drafts.filter((d) => d.fulfilledProductId !== null).length,
      draftPos: draftPos.length,
      matchedRealPos: realPoSummaries.length,
      unmatchedDraftItems: unmatchedDrafts.length,
    },
    realPos: realPoSummaries,
    draftPos: draftPoSummaries,
    unmatchedDrafts,
  };
}

function filterRealPos(realPos: readonly RealPoInput[], scope: LinkedPosScope): RealPoInput[] {
  // Explicit set takes precedence — return ONLY the listed PO ids.
  if (scope.explicitRealPoIds && scope.explicitRealPoIds.size > 0) {
    return realPos.filter((p) => scope.explicitRealPoIds!.has(p.id));
  }
  // Otherwise apply the date window. A null orderDate means "we don't
  // know when this PO was placed" — keep it in case it's relevant
  // (rare; usually only ancient FileMaker-era POs).
  if (scope.windowStart) {
    const cutoff = scope.windowStart.getTime();
    return realPos.filter((p) => p.orderDate === null || p.orderDate.getTime() >= cutoff);
  }
  return realPos.slice();
}

function filterRealPoLines(
  realPoLines: readonly RealPoLineInput[],
  scopedRealPos: readonly RealPoInput[],
): RealPoLineInput[] {
  const ids = new Set(scopedRealPos.map((p) => p.id));
  return realPoLines.filter((l) => ids.has(l.realPoId));
}

// Detect the vendor-name mismatch we saw empirically on 2026-05-14:
// draft PO 8 was typed as "Gat Creek" but the linked Product belongs to
// vendor "Caperton" (via PON08076). Cosmetic — doesn't break the link
// — but worth surfacing on the report so the buyer can decide whether
// to fix the draft or accept the relabel.
export interface VendorMismatchInput {
  draftPoId: number;
  draftVendorName: string;
  /** Real-PO vendor names (deduped) the draft's items actually map to. */
  realVendorNames: string[];
}

export interface VendorMismatch {
  draftPoId: number;
  draftVendorName: string;
  realVendorName: string;
}

export function detectVendorMismatches(inputs: readonly VendorMismatchInput[]): VendorMismatch[] {
  const out: VendorMismatch[] = [];
  for (const input of inputs) {
    if (input.realVendorNames.length === 0) continue;
    const draftNorm = input.draftVendorName.trim().toLowerCase();
    for (const realName of input.realVendorNames) {
      const realNorm = realName.trim().toLowerCase();
      if (draftNorm !== realNorm) {
        out.push({
          draftPoId: input.draftPoId,
          draftVendorName: input.draftVendorName,
          realVendorName: realName,
        });
      }
    }
  }
  return out;
}
