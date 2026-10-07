// /app/__tests__/helpers/postedJournal.ts
//
// `generateSalesJournal` returns `journalEntry: null` for a day whose activity
// offsets to zero in every account -- a sale and its full same-day refund, say
// -- because a net daily summary of activity that cancels is empty. That is a
// real, tested outcome, not an error.
//
// Every OTHER case builds a fixture that must post. Sprinkling `!` across those
// assertions would silence the null instead of ruling it out, and a fixture that
// quietly stopped producing lines would then fail somewhere confusing. This
// asserts the expectation once, in one place, and names it.

import type { generateSalesJournal } from "@/lib/journalEntry";

type GenerateResult = Awaited<ReturnType<typeof generateSalesJournal>>;
type PostedEntry = NonNullable<GenerateResult["journalEntry"]>;

/** The posted entry, or a failure naming why there wasn't one. */
export function posted(result: GenerateResult): PostedEntry {
  if (!result.journalEntry) {
    throw new Error(
      "expected generateSalesJournal to post an entry, but it posted none " +
        `(skipped: ${result.skipped ?? "unknown"}). The fixture's debits and ` +
        "credits offset to zero, so there was nothing to summarise.",
    );
  }
  return result.journalEntry;
}
