// scripts/parallel-run-compare.cjs
//
// Parallel-run trust gate: compare Holt's daily sales totals against the
// legacy system's database, day by day. Both systems ingest the same daily
// POS exports, so once Holt's auto-import is live their per-day totals must
// match to the penny — any drift means an import discrepancy to chase BEFORE
// Holt becomes the system of record.
//
// Runs the IDENTICAL canonical query on both sides (the schemas are sibling
// forks; every column this query touches has the same name in both):
//   revenue = SUM(OrderLineItem.netPrice)   [line totals, never x qty]
//   tax     = SUM(OrderLineItem.vatAmount)
//   orders  = COUNT(DISTINCT SalesOrder.id)
//   cash    = SUM(Payment.paymentAmount WHERE status = 'COMPLETED')
// over orders dated that day with status IN (ORDER, FULFILLED, RETURNED) and
// non-cancelled lines (NULL-safe — NULL lineItemStatus counts as active).
// This mirrors lib/dailyReconciliation.ts's source-side definition.
//
// Usage (on the deployment host, or locally against restored backups):
//   HOLT_DATABASE_URL=postgres://... LEGACY_DATABASE_URL=postgres://... \
//     node scripts/parallel-run-compare.cjs --from 2026-06-01 --to 2026-06-07
//
// Flags: --from/--to (YYYY-MM-DD, default: the last 7 full days)
//        --by-store   also break each drifted day down by storeLocation
//        --tolerance  dollars (default 0.01)
// Exit codes: 0 = all days within tolerance, 1 = drift found, 2 = usage error.
// Read-only: runs SELECTs only.

const TOTALS_SQL = `
  SELECT
    COALESCE(SUM(li."netPrice"), 0)::float8  AS revenue,
    COALESCE(SUM(li."vatAmount"), 0)::float8 AS tax,
    COUNT(DISTINCT so.id)::int               AS orders
  FROM "OrderLineItem" li
  JOIN "SalesOrder" so ON so.id = li."salesOrderId"
  WHERE so."orderDate" >= $1 AND so."orderDate" < $2
    AND so.status IN ('ORDER', 'FULFILLED', 'RETURNED')
    AND (li."lineItemStatus" IS NULL OR li."lineItemStatus" <> 'CANCELLED')
`;

const TOTALS_BY_STORE_SQL = `
  SELECT
    COALESCE(so."storeLocation", '(none)')   AS store,
    COALESCE(SUM(li."netPrice"), 0)::float8  AS revenue
  FROM "OrderLineItem" li
  JOIN "SalesOrder" so ON so.id = li."salesOrderId"
  WHERE so."orderDate" >= $1 AND so."orderDate" < $2
    AND so.status IN ('ORDER', 'FULFILLED', 'RETURNED')
    AND (li."lineItemStatus" IS NULL OR li."lineItemStatus" <> 'CANCELLED')
  GROUP BY 1 ORDER BY 1
`;

// NULL-safe status filter: payments imported from the legacy POS carry
// status = NULL (verified 46,048 of 46,050 rows in the restored production
// backup) — NULL is a real payment, not an incomplete one. A naked
// status = 'COMPLETED' reads $0 cash on legacy data.
const CASH_SQL = `
  SELECT COALESCE(SUM("paymentAmount"), 0)::float8 AS cash
  FROM "Payment"
  WHERE "paymentDate" >= $1 AND "paymentDate" < $2
    AND (status = 'COMPLETED' OR status IS NULL)
`;

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// Pure: list of YYYY-MM-DD strings from `from` to `to` inclusive (UTC days).
function listDays(fromIso, toIso) {
  const out = [];
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    throw new Error(`Invalid date range ${fromIso}..${toIso}`);
  }
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Pure: compare one day's totals from both systems. Returns the per-field
// drift (holt - legacy) and whether everything is inside the tolerance.
// `orders` is a count, so any mismatch at all counts as drift.
function diffDayTotals(holt, legacy, tolerance) {
  const drift = {
    revenue: round2(holt.revenue - legacy.revenue),
    tax: round2(holt.tax - legacy.tax),
    cash: round2(holt.cash - legacy.cash),
    orders: holt.orders - legacy.orders,
  };
  const balanced =
    Math.abs(drift.revenue) <= tolerance &&
    Math.abs(drift.tax) <= tolerance &&
    Math.abs(drift.cash) <= tolerance &&
    drift.orders === 0;
  return { drift, balanced };
}

// Pure: align two by-store revenue row sets into per-store drift lines.
function diffStores(holtRows, legacyRows, tolerance) {
  const stores = new Map();
  for (const r of holtRows) stores.set(r.store, { holt: r.revenue, legacy: 0 });
  for (const r of legacyRows) {
    const cur = stores.get(r.store) ?? { holt: 0, legacy: 0 };
    cur.legacy = r.revenue;
    stores.set(r.store, cur);
  }
  const out = [];
  for (const [store, v] of [...stores.entries()].sort()) {
    const drift = round2(v.holt - v.legacy);
    if (Math.abs(drift) > tolerance) {
      out.push({ store, holt: round2(v.holt), legacy: round2(v.legacy), drift });
    }
  }
  return out;
}

function parseArgs(argv) {
  const args = { byStore: false, tolerance: 0.01 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--by-store") args.byStore = true;
    else if (a === "--tolerance") args.tolerance = Number(argv[++i]);
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (!args.from || !args.to) {
    // Default: the last 7 FULL days (yesterday backwards), UTC.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const to = new Date(today);
    to.setUTCDate(to.getUTCDate() - 1);
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - 6);
    args.from = args.from ?? from.toISOString().slice(0, 10);
    args.to = args.to ?? to.toISOString().slice(0, 10);
  }
  if (!Number.isFinite(args.tolerance) || args.tolerance < 0) {
    throw new Error("--tolerance must be a non-negative number");
  }
  return args;
}

async function fetchDay(client, dayIso, byStore) {
  const start = `${dayIso}T00:00:00Z`;
  const endExclusive = new Date(`${dayIso}T00:00:00Z`);
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  const end = endExclusive.toISOString();

  const [totals, cash] = await Promise.all([
    client.query(TOTALS_SQL, [start, end]),
    client.query(CASH_SQL, [start, end]),
  ]);
  const day = {
    revenue: round2(totals.rows[0].revenue),
    tax: round2(totals.rows[0].tax),
    orders: totals.rows[0].orders,
    cash: round2(cash.rows[0].cash),
  };
  if (byStore) {
    const stores = await client.query(TOTALS_BY_STORE_SQL, [start, end]);
    day.stores = stores.rows.map((r) => ({ store: r.store, revenue: round2(r.revenue) }));
  }
  return day;
}

async function main() {
  // pg lives in app/node_modules; this script sits at the repo root so it can
  // be run on a deployment host without an install step of its own.
  const { createRequire } = require("node:module");
  const path = require("node:path");
  const appRequire = createRequire(path.join(__dirname, "..", "app", "package.json"));
  const { Client } = appRequire("pg");
  const args = parseArgs(process.argv.slice(2));

  const holtUrl = process.env.HOLT_DATABASE_URL;
  const legacyUrl = process.env.LEGACY_DATABASE_URL;
  if (!holtUrl || !legacyUrl) {
    console.error("Set HOLT_DATABASE_URL and LEGACY_DATABASE_URL.");
    process.exit(2);
  }

  const holt = new Client({ connectionString: holtUrl });
  const legacy = new Client({ connectionString: legacyUrl });
  await holt.connect();
  await legacy.connect();

  const days = listDays(args.from, args.to);
  console.log(
    `Parallel-run compare ${args.from}..${args.to} (${days.length} day(s), tolerance $${args.tolerance})`,
  );

  let driftDays = 0;
  try {
    for (const day of days) {
      const [h, l] = await Promise.all([
        fetchDay(holt, day, args.byStore),
        fetchDay(legacy, day, args.byStore),
      ]);
      const { drift, balanced } = diffDayTotals(h, l, args.tolerance);
      if (balanced) {
        console.log(
          `  ${day}  OK   revenue ${h.revenue.toFixed(2)}  tax ${h.tax.toFixed(2)}  cash ${h.cash.toFixed(2)}  orders ${h.orders}`,
        );
        continue;
      }
      driftDays++;
      console.log(
        `  ${day}  DRIFT  revenue ${drift.revenue.toFixed(2)} (holt ${h.revenue.toFixed(2)} vs legacy ${l.revenue.toFixed(2)})  ` +
          `tax ${drift.tax.toFixed(2)}  cash ${drift.cash.toFixed(2)}  orders ${drift.orders >= 0 ? "+" : ""}${drift.orders}`,
      );
      if (args.byStore && h.stores && l.stores) {
        for (const s of diffStores(h.stores, l.stores, args.tolerance)) {
          console.log(
            `           ${s.store}: ${s.drift.toFixed(2)} (holt ${s.holt.toFixed(2)} vs legacy ${s.legacy.toFixed(2)})`,
          );
        }
      }
    }
  } finally {
    await holt.end();
    await legacy.end();
  }

  if (driftDays > 0) {
    console.error(`${driftDays} day(s) drifted — investigate before cutover.`);
    process.exit(1);
  }
  console.log("All days tie out.");
}

module.exports = { listDays, diffDayTotals, diffStores, round2, parseArgs };

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  });
}
