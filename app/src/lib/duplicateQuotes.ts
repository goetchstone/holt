// /app/src/lib/duplicateQuotes.ts
//
// Pure duplicate-quote detection. Two quotes on the same customer are flagged
// as probable duplicates when either:
//   1) They share at least 50% of distinct part numbers, OR
//   2) Their totals are within 10% of each other AND >= $100
//
// Uses Jaccard-like set comparison: shared / max. Archived quotes are ignored.
// Runs in-memory over a batch — callers pre-filter the quotes they want to
// consider (e.g. active QUOTE-status only).
//
// Salesperson exclusion: when both quotes have a salesPersonId set AND those
// IDs differ, the pair is NOT flagged. Same-customer-different-designer is
// almost always a customer transfer (a designer left, a customer became
// someone else's, a fresh quote got written) -- not a duplicate. Origin:
// GitHub Issue #129. Lisa Ritz was Amy's customer, transferred to Kim after
// Amy left; Kim wrote SO-38985 and the detector flagged it as a duplicate
// of Amy's old SO-36936; someone hand-archived SO-38985 as "Updated Quote"
// without a replacement linked, and Kim's legitimate quote vanished from
// her pipeline. The detector now declines to surface that pair.

interface QuoteForDupCheck {
  id: number;
  orderno: string;
  customer: { id: number } | null;
  lineItems: { partNo: string | null; netPrice: unknown }[];
  pipelineArchivedAt: Date | string | null;
  salesPersonId?: number | null;
}

export interface DuplicateMatch {
  id: number;
  orderno: string;
}

const PART_OVERLAP_THRESHOLD = 0.5;
const TOTAL_SIMILARITY_THRESHOLD = 0.1; // 10%
const MIN_TOTAL_FOR_SIMILARITY = 100;

export function detectPossibleDuplicates(
  quotes: QuoteForDupCheck[],
): Map<number, DuplicateMatch[]> {
  const result = new Map<number, DuplicateMatch[]>();
  const byCustomer = new Map<number, QuoteForDupCheck[]>();
  for (const q of quotes) {
    if (!q.customer || q.pipelineArchivedAt) continue;
    const arr = byCustomer.get(q.customer.id) ?? [];
    arr.push(q);
    byCustomer.set(q.customer.id, arr);
  }

  for (const [, custQuotes] of byCustomer) {
    if (custQuotes.length < 2) continue;

    const summaries = custQuotes.map((q) => ({
      id: q.id,
      orderno: q.orderno,
      salesPersonId: q.salesPersonId ?? null,
      partNos: new Set(
        q.lineItems.map((li) => li.partNo?.toUpperCase()).filter((p): p is string => !!p),
      ),
      total: q.lineItems.reduce((s, li) => s + Number(li.netPrice), 0),
    }));

    for (let i = 0; i < summaries.length; i++) {
      const a = summaries[i];
      for (let j = i + 1; j < summaries.length; j++) {
        const b = summaries[j];

        // Same-customer-different-designer = customer transfer, not
        // duplicate. Skip the pair entirely so the UI doesn't surface it
        // and a well-meaning archive click can't bury the new designer's
        // legitimate quote (Issue #129).
        if (
          a.salesPersonId !== null &&
          b.salesPersonId !== null &&
          a.salesPersonId !== b.salesPersonId
        ) {
          continue;
        }

        // Part number overlap: shared / max
        const shared = [...a.partNos].filter((p) => b.partNos.has(p)).length;
        const maxParts = Math.max(a.partNos.size, b.partNos.size);
        const partOverlap = maxParts > 0 ? shared / maxParts : 0;

        // Total similarity: within threshold AND both >= $100
        let totalSimilar = false;
        if (a.total >= MIN_TOTAL_FOR_SIMILARITY && b.total >= MIN_TOTAL_FOR_SIMILARITY) {
          const diff = Math.abs(a.total - b.total);
          const max = Math.max(a.total, b.total);
          totalSimilar = diff / max <= TOTAL_SIMILARITY_THRESHOLD;
        }

        if (partOverlap >= PART_OVERLAP_THRESHOLD || totalSimilar) {
          const forA = result.get(a.id) ?? [];
          forA.push({ id: b.id, orderno: b.orderno });
          result.set(a.id, forA);

          const forB = result.get(b.id) ?? [];
          forB.push({ id: a.id, orderno: a.orderno });
          result.set(b.id, forB);
        }
      }
    }
  }

  return result;
}
