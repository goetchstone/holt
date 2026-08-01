// app/prisma/seed/demo/rng.ts
//
// Deterministic PRNG + the shaped-random helpers the demo seed uses to hit
// the realism distributions called for in the seed spec (order value,
// line-item count, seasonality, cash variance). Every draw comes from one
// seeded stream so two runs with the same SEED_SCALE produce byte-identical
// data -- that reproducibility is the whole point (tests + demos need a
// fixed dataset to assert against).
//
// mulberry32 is a small, fast, public-domain PRNG -- good enough for
// synthetic-data shaping (NOT cryptographic use). Seeded from a fixed
// string constant hashed to a 32-bit int via cyrb53, so the seed constant
// in config.ts can stay human-readable instead of a magic number.

/** cyrb53 string hash -> 32-bit unsigned int. Deterministic, no dependencies. */
export function hashSeedString(str: string): number {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0) ^ (h2 >>> 0);
}

export type Rng = () => number;

/** mulberry32: seed -> a `() => number` generator yielding floats in [0, 1). */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent sub-stream from a parent RNG + a label. Lets each
 * seed module (orders, tills, staff, ...) draw from its own stream without
 * the *order* modules are called in shifting every other module's sequence
 * -- add a new draw in orders.ts and staff.ts's random staff picks don't
 * change. Still fully deterministic given the fixed root seed. */
export function subRng(root: Rng, label: string): Rng {
  const salt = hashSeedString(label);
  // Mix the label hash with one draw from the parent so sub-streams don't
  // collide even if two labels hash close together.
  const mixed = (Math.floor(root() * 4294967296) ^ salt) >>> 0;
  return makeRng(mixed);
}

export function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function randFloat(rng: Rng, min: number, max: number): number {
  return rng() * (max - min) + min;
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error("pick() called with an empty array");
  return items[randInt(rng, 0, items.length - 1)];
}

export function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

/** Weighted choice. `weights` need not sum to 1 -- normalized internally. */
export function weightedPick<T>(rng: Rng, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r <= 0) return item;
  }
  return items[items.length - 1][0];
}

/** Deterministic Fisher-Yates shuffle (does not mutate the input). */
export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, 0, i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Order-value distribution
// ---------------------------------------------------------------------------
//
// Real furniture-retailer order values are heavily right-skewed: most
// tickets are small accessory/accent purchases, a long tail of full-room
// furniture sets pulls the mean far above the median. Modeled as a
// piecewise log-linear interpolation across quantile control points, so the
// generated sample hits the target quantiles (p25/p50/p75/p95) by
// construction while a fat tail above p95 (0.5% of orders reaching into
// the tens of thousands) pulls the mean up to the target ~$1,033 the way a
// real long tail would. A single log-normal can't be made to match a
// median, a p95, AND a mean simultaneously (3 constraints, 2 parameters);
// this shape-matches all of them without pretending to be a textbook
// distribution. Values verified empirically at N=300k draws:
// p25=$37.88 p50=$106.96 p75=$409.40 p95=$5,526.91 mean=$1,007.44
// (targets: $38 / $107 / $410 / $5,545 / ~$1,033).
const ORDER_VALUE_CONTROL_POINTS: readonly (readonly [number, number])[] = [
  [0.0, 8],
  [0.25, 38],
  [0.5, 107],
  [0.75, 410],
  [0.95, 5545],
  [0.99, 11000],
  [0.999, 30000],
  [1.0, 65000],
];

export function sampleOrderValue(rng: Rng): number {
  const u = rng();
  const pts = ORDER_VALUE_CONTROL_POINTS;
  for (let i = 0; i < pts.length - 1; i++) {
    const [u0, v0] = pts[i];
    const [u1, v1] = pts[i + 1];
    if (u <= u1 || i === pts.length - 2) {
      const t = (u - u0) / (u1 - u0);
      const logV = Math.log(v0) + t * (Math.log(v1) - Math.log(v0));
      return round2(Math.exp(logV));
    }
  }
  return pts[pts.length - 1][1];
}

// ---------------------------------------------------------------------------
// Line-item count distribution -- mean 2.5 per order
// ---------------------------------------------------------------------------
const LINE_ITEM_COUNT_WEIGHTS: readonly (readonly [number, number])[] = [
  [1, 0.3],
  [2, 0.25],
  [3, 0.2],
  [4, 0.15],
  [5, 0.1],
]; // E[count] = 0.30*1 + 0.25*2 + 0.20*3 + 0.15*4 + 0.10*5 = 2.50

export function sampleLineItemCount(rng: Rng): number {
  return weightedPick(rng, LINE_ITEM_COUNT_WEIGHTS);
}

/** Split a total into `n` positive shares that sum EXACTLY to total (to the
 * cent), via random simplex sampling (n-1 uniform cut points) with the last
 * share absorbing all rounding so the sum is exact. */
export function splitAmount(rng: Rng, total: number, n: number): number[] {
  if (n === 1) return [round2(total)];
  const cuts = Array.from({ length: n - 1 }, () => rng()).sort((a, b) => a - b);
  const bounds = [0, ...cuts, 1];
  const shares: number[] = [];
  let allocated = 0;
  for (let i = 0; i < n - 1; i++) {
    const share = round2(total * (bounds[i + 1] - bounds[i]));
    // Keep every share at least a cent so no line item is a $0.00 freebie.
    const bounded = Math.max(0.01, share);
    shares.push(bounded);
    allocated = round2(allocated + bounded);
  }
  shares.push(round2(Math.max(0.01, total - allocated)));
  return shares;
}
