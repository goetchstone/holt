// /app/src/lib/pricing/massChange.ts
//
// A mass price change (GAP-06): the server side of /api/pricing/mass-change.
// The contract (filter, operation, rows) is massChangeShared.ts; every write goes
// through retailWriter.ts with source MASS_CHANGE, so a locked price is kept and
// each change is in the price ledger under the run's batch id.

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma, TX_TIMEOUT } from "@/lib/prisma";
import { auditLog } from "@/lib/audit";
import type { PricingConfig } from "@/lib/appSettings";
import { resolveMarkup } from "@/lib/pricing/markup";
import { roundRetail } from "@/lib/pricing/rounding";
import {
  applyRetailChanges,
  moneyOrNull,
  sameMoney,
  setPriceLocks,
} from "@/lib/pricing/retailWriter";
import {
  MASS_CHANGE_MAX_PRODUCTS,
  tooMany,
  type MassChangeApplyResult,
  type MassChangeApplyRow,
  type MassChangeFilter,
  type MassChangeOperation,
  type MassChangePreviewRow,
  type MassChangeSelection,
  type MassChangeSkip,
  wasAboveRetail,
} from "@/lib/pricing/massChangeShared";

/** The products a filter matches. Active products only: a mass change prices what sells. */
export function massChangeWhere(filter: MassChangeFilter): Prisma.ProductWhereInput {
  const where: Prisma.ProductWhereInput = { isActive: true };
  if (filter.vendorId) where.vendorId = filter.vendorId;
  if (filter.departmentId) where.departmentId = filter.departmentId;
  if (filter.categoryId) where.categoryId = filter.categoryId;
  if (filter.locked) where.priceLocked = filter.locked === "locked";
  if (filter.q) {
    where.OR = [
      { productNumber: { contains: filter.q, mode: "insensitive" } },
      { name: { contains: filter.q, mode: "insensitive" } },
    ];
  }
  return where;
}

export class MassChangeRefused extends Error {}

/**
 * The product ids a selection means, in id order. A filter is resolved again
 * here, never trusted from the screen; over the cap is refused, not truncated.
 */
export async function resolveSelection(selection: MassChangeSelection): Promise<number[]> {
  if ("productIds" in selection) return [...selection.productIds].sort((a, b) => a - b);
  const where = massChangeWhere(selection.filter);
  const count = await prisma.product.count({ where });
  if (count > MASS_CHANGE_MAX_PRODUCTS) throw new MassChangeRefused(tooMany(count));
  const rows = await prisma.product.findMany({
    where,
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => r.id);
}

interface PreviewProduct {
  id: number;
  productNumber: string;
  name: string;
  baseCost: Prisma.Decimal | null;
  baseRetail: Prisma.Decimal | null;
  wasPrice: Prisma.Decimal | null;
  priceLocked: boolean;
  vendor: { defaultMarkup: Prisma.Decimal | null };
  category: { defaultMarkup: Prisma.Decimal | null };
}

/** What one product's retail would become; a skip says why it wouldn't. */
export function planRetail(
  product: PreviewProduct,
  operation: MassChangeOperation,
  pricing: PricingConfig,
): { toRetail: number | null; skipped: MassChangeSkip | null } {
  const fromRetail = moneyOrNull(product.baseRetail);
  const rounding = operation.rounding ?? pricing.retailRounding;
  const op = operation.retail;
  switch (op.kind) {
    case "KEEP":
      return { toRetail: fromRetail, skipped: null };
    case "AMOUNT":
      // A price someone typed is theirs: not rounded.
      return { toRetail: op.amount, skipped: null };
    case "PERCENT": {
      if (fromRetail === null || fromRetail <= 0) return { toRetail: null, skipped: "NO_RETAIL" };
      return computed(roundRetail(fromRetail * (1 + op.percent / 100), rounding));
    }
    case "FROM_MARKUP": {
      const cost = moneyOrNull(product.baseCost);
      if (cost === null || cost <= 0) return { toRetail: null, skipped: "NO_COST" };
      const markup = resolveMarkup({
        vendorMarkup: product.vendor.defaultMarkup,
        categoryMarkup: product.category.defaultMarkup,
        storeMarkup: pricing.defaultMarkup,
        precedence: pricing.markupPrecedence,
      });
      if (!markup) return { toRetail: null, skipped: "NO_MARKUP" };
      return computed(roundRetail(cost * markup.multiplier, rounding));
    }
  }
}

/**
 * A price worked out from a positive one. Rounding can take a small price to
 * nothing (40 cents to the nearest dollar), and a retail of 0 is no price at
 * the register (lib/pos/cartPricing.ts catalogRetailPrice): left out, not written.
 */
function computed(toRetail: number): { toRetail: number | null; skipped: MassChangeSkip | null } {
  return toRetail > 0 ? { toRetail, skipped: null } : { toRetail: null, skipped: "ROUNDS_TO_ZERO" };
}

/** What one product's was price would become. */
export function planWas(
  fromRetail: number | null,
  fromWas: number | null,
  operation: MassChangeOperation,
): number | null {
  if (operation.was === "CLEAR") return null;
  // A markdown: the price it is at now becomes the price it was.
  if (operation.was === "FROM_CURRENT" && fromRetail !== null && fromRetail > 0) {
    return Math.round(fromRetail * 100) / 100;
  }
  return fromWas;
}

/** Each selected product's price before and after, or why it is left out. Writes nothing. */
export async function previewMassChange(
  productIds: readonly number[],
  operation: MassChangeOperation,
  pricing: PricingConfig,
): Promise<MassChangePreviewRow[]> {
  const products = await prisma.product.findMany({
    where: { id: { in: [...productIds] } },
    orderBy: { id: "asc" },
    select: {
      id: true,
      productNumber: true,
      name: true,
      baseCost: true,
      baseRetail: true,
      wasPrice: true,
      priceLocked: true,
      vendor: { select: { defaultMarkup: true } },
      category: { select: { defaultMarkup: true } },
    },
  });
  return products.map((p) => {
    const fromRetail = moneyOrNull(p.baseRetail);
    const fromWas = moneyOrNull(p.wasPrice);
    const base = {
      productId: p.id,
      productNumber: p.productNumber,
      name: p.name,
      fromRetail,
      fromWas,
    };
    const plan = planRetail(p, operation, pricing);
    if (plan.skipped)
      return { ...base, toRetail: fromRetail, toWas: fromWas, skipped: plan.skipped };
    const toWas = planWas(fromRetail, fromWas, operation);
    let skipped: MassChangeSkip | null = null;
    if (sameMoney(fromRetail, plan.toRetail) && sameMoney(fromWas, toWas)) skipped = "UNCHANGED";
    else if (p.priceLocked) skipped = "LOCKED";
    // A was price at or under the retail is no sale (a price going up, or
    // "markdown" with retail kept): a sale tag refuses it (lib/labels/productTag.ts).
    else if (!wasAboveRetail(toWas, plan.toRetail)) skipped = "WAS_NOT_ABOVE";
    return { ...base, toRetail: plan.toRetail, toWas, skipped };
  });
}

/**
 * Apply previewed rows in ONE transaction: a row whose price moved since the
 * preview is refused as stale, a locked product is kept, the rest change
 * through the retail writer under a new batch id, with one PRICES_ADJUSTED
 * entry for the run.
 */
export async function applyMassChange(
  rows: readonly MassChangeApplyRow[],
  options: { actor: string; note?: string | null },
): Promise<MassChangeApplyResult> {
  const batchId = randomUUID();
  return prisma.$transaction(
    (tx) => applyMassChangeInTx(tx, rows, { ...options, batchId }),
    TX_TIMEOUT.LONG,
  );
}

/**
 * applyMassChange's work inside the caller's transaction, under the caller's
 * batch id -- for the demo seed, so its markdown is recorded exactly as a run
 * from the screen is, PRICES_ADJUSTED entry and all.
 */
export async function applyMassChangeInTx(
  tx: Prisma.TransactionClient,
  rows: readonly MassChangeApplyRow[],
  options: { actor: string; batchId: string; note?: string | null },
): Promise<MassChangeApplyResult> {
  const { batchId } = options;
  const result = await applyRetailChanges(
    tx,
    rows.map((r) => ({
      productId: r.productId,
      toRetail: r.toRetail,
      toWas: r.toWas,
      expectFromRetail: r.fromRetail,
      expectFromWas: r.fromWas,
    })),
    {
      source: "MASS_CHANGE",
      actor: options.actor,
      batchId,
      note: options.note ?? null,
      honourLock: true,
      audit: "caller",
    },
  );
  const counts = {
    changed: result.changed.length,
    unchanged: result.unchanged.length,
    skippedLocked: result.skippedLocked.length,
    stale: result.stale.length,
    missing: result.missing.length,
  };
  if (counts.changed > 0) {
    await auditLog(
      "PRICES_ADJUSTED",
      options.actor,
      {
        summary: `Mass price change: ${counts.changed} ${counts.changed === 1 ? "product" : "products"} repriced`,
        details: { batchId, ...counts, ...(options.note && { note: options.note }) },
      },
      tx,
    );
  }
  return {
    batchId,
    changed: counts.changed,
    unchanged: counts.unchanged,
    skippedLocked: counts.skippedLocked,
    stale: result.stale,
    missing: result.missing,
  };
}

/** Lock or unlock a selection's prices in one transaction, with one entry for the run. */
export async function lockMassChange(
  productIds: readonly number[],
  locked: boolean,
  actor: string,
): Promise<{ changed: number; unchanged: number; missing: number[] }> {
  return prisma.$transaction(async (tx) => {
    const result = await setPriceLocks(tx, productIds, locked, { actor, audit: "caller" });
    if (result.changed.length > 0) {
      const n = result.changed.length;
      await auditLog(
        "PRICE_LOCK_CHANGED",
        actor,
        {
          summary: `${n} ${n === 1 ? "price" : "prices"} ${locked ? "locked" : "unlocked"}`,
          details: { locked, productIds: result.changed.map((c) => c.productId) },
        },
        tx,
      );
    }
    return {
      changed: result.changed.length,
      unchanged: result.unchanged.length,
      missing: result.missing,
    };
  }, TX_TIMEOUT.LONG);
}
