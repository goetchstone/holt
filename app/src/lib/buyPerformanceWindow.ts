// /app/src/lib/buyPerformanceWindow.ts
//
// Slice 6.2 (2026-05-12) — sales-window derivation for Buy performance.
//
// Buyer's mental model: sales attributable to a Buy can only happen AFTER
// the goods could plausibly be on the floor — i.e. the PO's expected
// ship/delivery date. Sales before that anchor belong to the PRIOR buy
// of the same frames; counting them here would inflate this buy's
// sell-through and obscure the actual performance of THIS buy's units.
//
// Resolution order (per PO, then min across the buy):
//   1. `expectedDeliveryDate` (precise) — wins when set
//   2. `expectedShipMonth` ("YYYY-MM" string) → first-of-month
//   3. Neither set on any PO → fallback to full history with a visible
//      warning so the UI prompts the user to set an ETA
//
// Pure helper. No I/O. The API endpoint hydrates the inputs.

export interface BuyPoForWindow {
  /** Since 2026-05-13 DateTime promotion the column is `DateTime?`,
   *  so callers usually pass a Date. We still accept string for
   *  backwards compat (e.g. an API caller serializing dates as ISO).
   *  `parseShipMonth` already handles both. */
  expectedShipMonth: Date | string | null;
  expectedDeliveryDate: Date | null;
  /** Phase 6.8 (2026-05-14) — earliest `ReceivingRecord.receivedDate`
   *  the API has for this draft PO, joined through the linked real
   *  PO via productId match. Wins over planned dates when set —
   *  actual arrival is the most accurate "this frame was available
   *  to sell starting here" anchor. For future-looking buys with no
   *  receipts yet, this is null and we fall back to the planned
   *  dates. */
  actualReceivedDate?: Date | null;
}

export type SalesWindowSource =
  | "actualReceivedDate"
  | "expectedDeliveryDate"
  | "expectedShipMonth"
  | "fallback-full-history";

export interface SalesWindow {
  /** Inclusive lower bound on orderDate. null = no lower bound (full history). */
  start: Date | null;
  /** Exclusive upper bound on orderDate (typically `now`). */
  end: Date;
  /** Which field on which PO contributed the `start` value. */
  source: SalesWindowSource;
  /** Human-readable note for the UI header. */
  message: string;
}

/** Parse a month string to the first-of-month Date in UTC.
 *
 *  Accepts BOTH canonical `YYYY-MM` (what `<input type="month">` should
 *  emit per spec) AND `MM-YYYY` (what we've observed in real production
 *  data — see failure log 2026-05-13). Disambiguates by digit-count
 *  per half: one half is 4-digit year ≥ 1900, the other half is 2-digit
 *  month 1-12. Ambiguous shapes ("01-02" with both 2-digit) return null
 *  rather than guessing.
 *
 *  Returns null on any unparseable input (empty, wrong format, NaN,
 *  legacy free-text like "March").
 */
export function parseShipMonth(value: string | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Two accepted shapes: 4-then-2 OR 2-then-4 digits separated by a single dash.
  const match = /^(\d{2}|\d{4})-(\d{2}|\d{4})$/.exec(trimmed);
  if (!match) return null;
  const [, leftStr, rightStr] = match;
  const left = Number.parseInt(leftStr, 10);
  const right = Number.parseInt(rightStr, 10);

  // YYYY-MM: left is year, right is month.
  if (leftStr.length === 4 && rightStr.length === 2) {
    return buildMonthDate(left, right);
  }
  // MM-YYYY: left is month, right is year.
  if (leftStr.length === 2 && rightStr.length === 4) {
    return buildMonthDate(right, left);
  }
  // Anything else (both 2-digit "01-02", both 4-digit "2026-2027") is
  // ambiguous — refuse to guess.
  return null;
}

function buildMonthDate(year: number, month: number): Date | null {
  if (year < 1900 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  const d = new Date(Date.UTC(year, month - 1, 1));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Normalize a permissive month string to canonical YYYY-MM, or null
 *  when it can't be parsed. Used by the modal save path so we stop
 *  writing MM-YYYY to the DB going forward — even if some browsers /
 *  manual input paths emit it. */
export function normalizeShipMonth(value: string | null): string | null {
  const d = parseShipMonth(value);
  if (d === null) return null;
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Format a ship-month value (Date, ISO string, YYYY-MM, or MM-YYYY)
 *  to the `YYYY-MM` shape that `<input type="month">` accepts as its
 *  `value` attribute. Returns "" for null / unparseable so the input
 *  renders empty rather than "null". */
export function formatShipMonthForInput(value: Date | string | null | undefined): string {
  if (value === null || value === undefined) return "";
  // Already a YYYY-MM string? Pass through (avoid a redundant round-trip).
  if (typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.trim())) {
    return value.trim();
  }
  // ISO datetime string or MM-YYYY → reuse the parsers.
  const d = value instanceof Date ? value : (parseShipMonth(value) ?? parseIsoLoose(value));
  if (d === null) return "";
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

/** Format a ship-month value for human display ("March 2026"). Returns
 *  null for unparseable input so the caller can branch on whether to
 *  render the chip at all. */
export function formatShipMonthForDisplay(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : (parseShipMonth(value) ?? parseIsoLoose(value));
  if (d === null || Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Internal: parse a full ISO datetime string (what the API serializes
 *  for a Prisma DateTime column). Returns null on anything that isn't
 *  parseable as a Date. */
function parseIsoLoose(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Format a date as "Month YYYY" (e.g. "March 2026") for UI display. */
function formatMonthYear(d: Date): string {
  return d.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

export interface DeriveSalesWindowInput {
  pos: ReadonlyArray<BuyPoForWindow>;
  /** "Now" passed in for determinism in tests. */
  now: Date;
}

/**
 * Per-PO signal picker. Returns the best (most accurate) available
 * date for one PO, or null if none of the fields are usable. Tagged
 * with `source` so the caller can carry the precedence through.
 *
 * Precedence: actualReceivedDate > expectedDeliveryDate > expectedShipMonth.
 */
function pickPoSignal(po: BuyPoForWindow): { date: Date; source: SalesWindowSource } | null {
  if (po.actualReceivedDate) {
    return { date: po.actualReceivedDate, source: "actualReceivedDate" };
  }
  if (po.expectedDeliveryDate !== null) {
    return { date: po.expectedDeliveryDate, source: "expectedDeliveryDate" };
  }
  const raw = po.expectedShipMonth;
  const fromMonth = raw instanceof Date ? raw : parseShipMonth(raw);
  if (fromMonth !== null) {
    return { date: fromMonth, source: "expectedShipMonth" };
  }
  return null;
}

/**
 * Derive the inclusive [start, end) window for sales attributable to
 * this Buy. See module header for the resolution order + rationale.
 */
export function deriveSalesWindow(input: DeriveSalesWindowInput): SalesWindow {
  let earliest: { date: Date; source: SalesWindowSource } | null = null;

  for (const po of input.pos) {
    const signal = pickPoSignal(po);
    if (signal === null) continue;
    if (earliest === null || signal.date < earliest.date) {
      earliest = signal;
    }
  }

  if (earliest === null) {
    return {
      start: null,
      end: input.now,
      source: "fallback-full-history",
      message:
        "No PO ETA set on this buy. Set an ETA on a draft PO to anchor the sales window; " +
        "otherwise sales for these frames from any prior buy will be counted here.",
    };
  }

  return {
    start: earliest.date,
    end: input.now,
    source: earliest.source,
    message: `Sales since ${formatMonthYear(earliest.date)}`,
  };
}

/**
 * Shift a window back by one year for the prior-year compare panel.
 * If start is null (fallback case), the comparable window also has
 * no lower bound — full-history compare. The end shifts even when
 * start doesn't, so the prior-year panel never spans the present.
 */
export function shiftWindowOneYearBack(window: SalesWindow): SalesWindow {
  const shiftedEnd = shiftOneYear(window.end);
  const shiftedStart = window.start === null ? null : shiftOneYear(window.start);
  return {
    start: shiftedStart,
    end: shiftedEnd,
    source: window.source,
    message:
      shiftedStart === null
        ? `Prior-year compare — full history up to ${formatMonthYear(shiftedEnd)}`
        : `Prior-year compare: ${formatMonthYear(shiftedStart)} – ${formatMonthYear(shiftedEnd)}`,
  };
}

function shiftOneYear(d: Date): Date {
  const out = new Date(d);
  out.setUTCFullYear(out.getUTCFullYear() - 1);
  return out;
}
