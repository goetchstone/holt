// app/prisma/seed/demo/config.ts
//
// Volume knob + fixed RNG seed + the 18-month seasonality shape for the
// synthetic demo dataset. See docs/domains/seed-data.md for the full
// writeup of every distribution choice below.

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
 * Monthly seasonality -- RELATIVE order-count weights measured (shape only)
 * from a real furniture retailer's yearly pattern. December runs ~3.5x
 * February. Applied per calendar month regardless of which year that month
 * falls in, so the pattern repeats across the 18-month window.
 */
export const MONTHLY_SEASONALITY: Record<number, number> = {
  0: 1097, // Jan
  1: 712, // Feb
  2: 762, // Mar
  3: 849, // Apr
  4: 1234, // May
  5: 972, // Jun
  6: 871, // Jul
  7: 1310, // Aug
  8: 800, // Sep
  9: 1052, // Oct
  10: 1501, // Nov
  11: 2459, // Dec
};

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
const DEFAULT_AS_OF = "2026-08-01";

export function seedWindow(argv: readonly string[] = []): { start: Date; end: Date } {
  const flag = argv.find((a) => a.startsWith("--as-of="));
  const raw = flag?.split("=")[1] || process.env.HOLT_SEED_AS_OF || DEFAULT_AS_OF;
  const end = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime())) {
    throw new Error(`Invalid --as-of/HOLT_SEED_AS_OF date "${raw}" -- expected YYYY-MM-DD.`);
  }
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 18);
  return { start, end };
}
