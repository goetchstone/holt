// app/prisma/seed/demo/config.ts
//
// Volume knob + fixed RNG seed + the 18-month seasonality shape for the
// synthetic demo dataset. See docs/domains/seed-data.md for the full
// writeup of every distribution choice below.

import { businessDayStart } from "@/lib/reports/businessDay";
import { hashSeedString } from "./rng";

/**
 * Fixed root seed -- the ENTIRE dataset is a pure function of this string.
 * Two runs with the same SEED_SCALE (and no --reset-induced ordering
 * change) produce byte-identical rows. Do not change this value casually;
 * it invalidates any test fixture or demo snapshot built against it.
 */
export const ROOT_SEED_STRING = "holt-demo-seed-v1";
export const ROOT_SEED = hashSeedString(ROOT_SEED_STRING);

export type SeedScale = "ci" | "demo";

export interface VolumeConfig {
  scale: SeedScale;
  /** Total SalesOrder count across the whole 18-month window. */
  orderCount: number;
  customerCount: number;
  productCount: number;
  /** Purchase orders raised against vendors (separate from sales-driven ones). */
  purchaseOrderCount: number;
  consignmentItemCount: number;
  serviceCaseCount: number;
  ticketCount: number;
  timeEntryCount: number;
  /** DESIGNER-role staff (the commissioned sales floor). */
  designerCount: number;
}

const VOLUME_PRESETS: Record<SeedScale, VolumeConfig> = {
  // Small, fast -- default. Sized to seed + verify in well under a minute
  // in CI without ballooning the checked-in expectations of anyone running
  // the unit/integration suite against a seeded scratch DB.
  ci: {
    scale: "ci",
    orderCount: 420,
    customerCount: 180,
    productCount: 160,
    purchaseOrderCount: 40,
    consignmentItemCount: 30,
    serviceCaseCount: 24,
    ticketCount: 18,
    timeEntryCount: 60,
    designerCount: 6,
  },
  // Demo-sized -- enough volume that dashboards, reports, and the
  // commission tier ladder all have something to show. Still finishes in a
  // couple of minutes on a laptop.
  demo: {
    scale: "demo",
    orderCount: 6000,
    customerCount: 1400,
    productCount: 500,
    purchaseOrderCount: 260,
    consignmentItemCount: 140,
    serviceCaseCount: 90,
    ticketCount: 70,
    timeEntryCount: 300,
    designerCount: 10,
  },
};

/** Reads HOLT_SEED_SCALE=ci|demo (default "ci") or a --scale=demo CLI flag. */
export function resolveScale(argv: readonly string[]): SeedScale {
  const flag = argv.find((a) => a.startsWith("--scale="));
  const fromFlag = flag?.split("=")[1];
  const fromEnv = process.env.HOLT_SEED_SCALE;
  const raw = (fromFlag || fromEnv || "ci").trim().toLowerCase();
  if (raw !== "ci" && raw !== "demo") {
    throw new Error(
      `Invalid scale "${raw}" -- expected "ci" or "demo" (HOLT_SEED_SCALE or --scale=).`,
    );
  }
  return raw;
}

export function resolveVolume(argv: readonly string[]): VolumeConfig {
  return VOLUME_PRESETS[resolveScale(argv)];
}

/**
 * Monthly seasonality -- RELATIVE order-count weights (shape only) for a
 * typical furniture-retail year. December runs ~3.5x
 * February. Applied per calendar month regardless of which year that month
 * falls in, so the pattern repeats across the 18-month window.
 */
export const MONTHLY_SEASONALITY: Record<number, number> = {
  0: 1.1, // Jan
  1: 0.7, // Feb
  2: 0.75, // Mar
  3: 0.85, // Apr
  4: 1.25, // May
  5: 1.0, // Jun
  6: 0.85, // Jul
  7: 1.3, // Aug
  8: 0.8, // Sep
  9: 1.05, // Oct
  10: 1.5, // Nov
  11: 2.45, // Dec
};

/**
 * The demo business's timezone -- AppSettings.timezone (org.ts) reads it, and so
 * does every module that puts a sale on a day. Reports and the dashboard bucket
 * days in this zone (lib/reports/businessDay.ts), so a sale seeded at "18:00
 * UTC" would land on a different business day than the one the seed meant.
 */
export const SEED_TIME_ZONE = "America/New_York";

/** Showroom hours, local time: the first and last hour a sale is rung. */
export const STORE_OPEN_HOUR = 10;
export const STORE_LAST_SALE_HOUR = 19;

/** The one sales-tax rate the seed's single tax district charges. The order
 * plan's line tax, each seeded line's vatRate and the district's TaxRule all
 * read it, so they cannot disagree. */
export const SEED_TAX_RATE = 0.06;

/** Payment-method mix by ROW count (not per-order): matches the seed spec
 * exactly. Refunds are layered on top of the base tender mix -- see
 * salesOrders.ts for how the 6% figure is achieved without skewing the
 * other four percentages. */
export const PAYMENT_METHOD_MIX: readonly (readonly [string, number])[] = [
  ["CARD", 85],
  ["CASH", 4],
  ["GIFT_CARD", 3],
  ["STORE_CREDIT", 2],
];
export const REFUND_SHARE_OF_ALL_PAYMENTS = 0.06;

/**
 * Window: 18 months ending on a fixed reference date, NOT `new Date()`.
 *
 * True determinism ("two runs produce identical data") is only possible if
 * every input is fixed -- including "now". Anchoring to the live clock
 * would make the dataset silently drift a day at a time and break
 * reproducibility for anyone re-running the seed on a later date (exactly
 * the failure mode the spec's determinism requirement rules out).
 *
 * `HOLT_SEED_AS_OF` (YYYY-MM-DD) overrides the anchor for anyone who wants
 * a freshly-dated dataset later -- the default keeps today's run and a run
 * five years from now producing the same rows.
 */
/**
 * The seed window ends TODAY unless something pins it.
 *
 * This was a hardcoded date, which meant a demo went stale a day at a time:
 * seeded once, and from then on the dashboard's "today" had no sales, the
 * dispatch board's "today" had no runs, and every screen keyed to now drifted
 * further from the data behind it. Three weeks after seeding, the first screen
 * a viewer sees reads $0.
 *
 * `--as-of=YYYY-MM-DD` and `HOLT_SEED_AS_OF` still pin it, which is what any
 * caller wanting reproducibility should use. Nothing in the test suite depends
 * on the old constant -- checked, not assumed.
 */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface SeedWindow {
  start: Date;
  /** Midnight UTC of the as-of date: the last day that has sales. */
  end: Date;
  /**
   * The moment the dataset describes -- what "now" means to every module that
   * dates something relative to today (open POs, delivery runs, who is on the
   * floor). The real clock when unpinned; 4pm on the as-of date, store time,
   * when --as-of pins it, so a pinned run never mixes a fixed sales history
   * with today's wall clock.
   */
  now: Date;
}

export function seedWindow(argv: readonly string[] = []): SeedWindow {
  const flag = argv.find((a) => a.startsWith("--as-of="));
  const pinned = flag?.split("=")[1] || process.env.HOLT_SEED_AS_OF;
  const raw = pinned || todayUtc();
  const end = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime())) {
    throw new Error(`Invalid --as-of/HOLT_SEED_AS_OF date "${raw}" -- expected YYYY-MM-DD.`);
  }
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 18);
  const now = pinned
    ? new Date(businessDayStart(raw, SEED_TIME_ZONE).getTime() + 16 * 3_600_000)
    : new Date();
  return { start, end, now };
}
