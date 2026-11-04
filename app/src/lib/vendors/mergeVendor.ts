// /app/src/lib/vendors/mergeVendor.ts
//
// GAP-22: merge a duplicate vendor into the one the store keeps. Everything
// that names the duplicate moves to the kept vendor, the duplicate's name
// becomes an alias of it (VendorAlias, which every name lookup in
// lib/vendors/vendorByName.ts finds), and the duplicate is deleted. One
// transaction: all of it happens or none of it.
//
// It refuses, naming each reason, rather than guess:
//   - records the database keeps one of per vendor, held by both (two styles
//     numbered 1010, two price lists named "2026");
//   - an item that would list its own vendor among its other vendors;
//   - a consignment vendor and one that isn't (consignment decides who owns the
//     stock and who is paid when it sells);
//   - a commission rule for the duplicate: moving it would widen it to the kept
//     vendor's items, and dropping its vendor would widen it to every vendor.
// Same-named collections fold together, because a collection is only a name.
//
// The kept vendor keeps its own details. Contact details, terms, lead time,
// minimum order and code it doesn't have are taken from the duplicate, and the
// duplicate's notes are added to its own. Its pricing settings never change,
// since they price the kept vendor's own items.
//
// VENDOR_REFERENCES lists every model that names a vendor and what a merge does
// with it. __tests__/vendorMergeCoverage.test.ts fails when the schema and the
// list disagree (rule 65).

import { Prisma, type PrismaClient } from "@prisma/client";
import { logError } from "@/lib/logger";
import { TX_TIMEOUT } from "@/lib/prisma";
import type { VendorMergePreview } from "@/lib/vendors/vendorMergeShared";

export class VendorMergeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "VendorMergeError";
  }
}

/** Every model with a vendor column, and what a merge does with its rows. */
export const VENDOR_REFERENCES = {
  Product: "moved",
  VendorContact: "moved",
  VendorNumberPrefix: "moved",
  VendorStyle: "moved; refused when both have the style number",
  Collection: "moved; same-named collections folded together (no foreign key)",
  PriceList: "moved; refused when both have the name",
  VendorPriceDimension: "moved; refused when both have the name",
  FabricCatalog: "moved; refused when both have the fabric in the colour",
  VendorOptionGroup: "moved; refused when both have the name",
  VendorProgram: "moved; refused when both have the name",
  SEComponent: "moved; refused when both have the component code",
  ProductSource: "moved; refused when an item would list a vendor twice",
  PurchaseOrder: "moved",
  BuyerDraftPurchaseOrder: "moved",
  BuyerDraftItem: "moved",
  ServiceCase: "moved",
  ConsignmentReceipt: "moved",
  ConsignmentItem: "moved",
  ConsignmentPaymentBatch: "moved",
  ConsignmentVendorReturn: "moved",
  ImportDefinition: "moved",
  VendorAlias: "moved",
  CommissionPlanRule: "refused: a rule for the duplicate must be changed first",
} as const;

type Tx = Prisma.TransactionClient;

let merges = 0;

/**
 * How many merges this process has made. A cache of vendor ids (the Ordorite
 * import's Unknown Vendor) is stale once this changes: its vendor may be the
 * one merged away.
 */
export function vendorMergeCount(): number {
  return merges;
}

/** The rows moved by a plain vendorId change (Prisma delegate), with what the plan calls one and many. */
export const MOVED = [
  ["product", "item", "items"],
  ["vendorContact", "contact", "contacts"],
  ["vendorNumberPrefix", "number prefix", "number prefixes"],
  ["vendorStyle", "style", "styles"],
  ["collection", "collection", "collections"],
  ["priceList", "price list", "price lists"],
  ["vendorPriceDimension", "price dimension", "price dimensions"],
  ["fabricCatalog", "fabric", "fabrics"],
  ["vendorOptionGroup", "option group", "option groups"],
  ["vendorProgram", "program", "programs"],
  ["sEComponent", "component", "components"],
  ["productSource", "item it sells us besides its own", "items it sells us besides its own"],
  ["purchaseOrder", "purchase order", "purchase orders"],
  ["buyerDraftPurchaseOrder", "buyer draft order", "buyer draft orders"],
  ["buyerDraftItem", "buyer draft item", "buyer draft items"],
  ["serviceCase", "service case", "service cases"],
  ["consignmentReceipt", "consignment receipt", "consignment receipts"],
  ["consignmentItem", "consignment item", "consignment items"],
  ["consignmentPaymentBatch", "consignment payment", "consignment payments"],
  ["consignmentVendorReturn", "consignment return", "consignment returns"],
  ["importDefinition", "import definition", "import definitions"],
  ["vendorAlias", "earlier name", "earlier names"],
] as const;

type MovedModel = (typeof MOVED)[number][0];

interface VendorIdDelegate {
  count(args: { where: { vendorId: number } }): Promise<number>;
  updateMany(args: {
    where: { vendorId: number };
    data: { vendorId: number; vendorName?: string };
  }): Promise<{ count: number }>;
}

/**
 * A buyer draft keeps its vendor's name beside the id, and the draft-to-PO
 * check (lib/buyerDraftRealPoLink.ts) compares it with the real PO's vendor,
 * so a draft takes the kept vendor's name along with its id.
 */
const KEEPS_VENDOR_NAME: ReadonlySet<MovedModel> = new Set([
  "buyerDraftPurchaseOrder",
  "buyerDraftItem",
]);

function delegate(tx: Tx, model: MovedModel): VendorIdDelegate {
  return tx[model] as unknown as VendorIdDelegate;
}

/** Details taken from the duplicate when the kept vendor has none. */
const TAKEN = [
  ["code", "code"],
  ["website", "website"],
  ["accountNumber", "account number"],
  ["paymentTerms", "payment terms"],
  ["freightTerms", "freight terms"],
  ["leadTimeDays", "lead time"],
  ["minimumOrder", "minimum order"],
  ["address", "address"],
  ["city", "city"],
  ["state", "state"],
  ["zip", "zip"],
  ["phone", "phone"],
  ["email", "email"],
] as const;

type TakenField = (typeof TAKEN)[number][0];

const VENDOR = {
  id: true,
  name: true,
  isConsignment: true,
  notes: true,
  code: true,
  website: true,
  accountNumber: true,
  paymentTerms: true,
  freightTerms: true,
  leadTimeDays: true,
  minimumOrder: true,
  address: true,
  city: true,
  state: true,
  zip: true,
  phone: true,
  email: true,
} as const satisfies Record<TakenField | "id" | "name" | "isConsignment" | "notes", true>;

type MergeVendor = Prisma.VendorGetPayload<{ select: typeof VENDOR }>;

const isBlank = (value: unknown) =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "");

/** "A, B, C and 4 more" */
function some(items: readonly string[], max = 5): string {
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/** The records both vendors hold under one key, by the name the plan shows. */
function shared<T>(
  fromRows: T[],
  intoRows: T[],
  key: (row: T) => string,
  label: (row: T) => string = key,
): string[] {
  const intoKeys = new Set(intoRows.map(key));
  const labels = fromRows.filter((r) => intoKeys.has(key(r))).map(label);
  return [...new Set(labels)].sort((a, b) => a.localeCompare(b));
}

async function keyedClashes(tx: Tx, fromId: number, intoId: number): Promise<string[]> {
  const both = { vendorId: { in: [fromId, intoId] } };
  const held = <T extends { vendorId: number }>(
    rows: T[],
    key: (row: T) => string,
    label?: (row: T) => string,
  ) =>
    shared(
      rows.filter((r) => r.vendorId === fromId),
      rows.filter((r) => r.vendorId === intoId),
      key,
      label,
    );
  const [styles, lists, dimensions, fabrics, groups, programs, components] = await Promise.all([
    tx.vendorStyle.findMany({ where: both, select: { vendorId: true, styleNumber: true } }),
    tx.priceList.findMany({ where: both, select: { vendorId: true, name: true } }),
    tx.vendorPriceDimension.findMany({ where: both, select: { vendorId: true, name: true } }),
    tx.fabricCatalog.findMany({
      where: both,
      select: { vendorId: true, fabricName: true, colorName: true },
    }),
    tx.vendorOptionGroup.findMany({ where: both, select: { vendorId: true, name: true } }),
    tx.vendorProgram.findMany({ where: both, select: { vendorId: true, name: true } }),
    tx.sEComponent.findMany({
      where: both,
      select: { vendorId: true, componentType: true, code: true },
    }),
  ]);
  const problems: string[] = [];
  const add = (found: string[], one: string, many: string) => {
    if (found.length) problems.push(`Both have ${found.length === 1 ? one : many} ${some(found)}.`);
  };
  add(
    held(styles, (s) => s.styleNumber),
    "style",
    "styles",
  );
  add(
    held(lists, (l) => l.name),
    "a price list named",
    "price lists named",
  );
  add(
    held(dimensions, (d) => d.name),
    "a price dimension named",
    "price dimensions named",
  );
  add(
    held(
      fabrics,
      (f) => JSON.stringify([f.fabricName, f.colorName]),
      (f) => (f.colorName ? `${f.fabricName} in ${f.colorName}` : f.fabricName),
    ),
    "the fabric",
    "the fabrics",
  );
  add(
    held(groups, (g) => g.name),
    "an option group named",
    "option groups named",
  );
  add(
    held(programs, (p) => p.name),
    "a program named",
    "programs named",
  );
  add(
    held(
      components,
      (c) => JSON.stringify([c.componentType, c.code]),
      (c) => `${c.componentType} ${c.code}`,
    ),
    "the component",
    "the components",
  );
  return problems;
}

/**
 * Items that would list a vendor twice once the duplicate's rows are the kept
 * vendor's: as their own vendor and another, or as another vendor twice.
 */
async function sourceClashes(tx: Tx, from: MergeVendor, into: MergeVendor): Promise<string[]> {
  const rows = await tx.productSource.findMany({
    where: { vendorId: { in: [from.id, into.id] } },
    select: {
      productId: true,
      vendorId: true,
      product: { select: { name: true, vendorId: true } },
    },
  });
  const listsBoth = new Map<number, string>();
  const ownAndOther = new Map<number, string>();
  const byProduct = new Map<number, Set<number>>();
  for (const row of rows) {
    const vendors = byProduct.get(row.productId) ?? new Set<number>();
    vendors.add(row.vendorId);
    byProduct.set(row.productId, vendors);
    if (vendors.size === 2) listsBoth.set(row.productId, row.product.name);
    const own = row.product.vendorId;
    const ownIsOther =
      (own === into.id && row.vendorId === from.id) ||
      (own === from.id && row.vendorId === into.id);
    if (ownIsOther) ownAndOther.set(row.productId, row.product.name);
  }
  const names = (m: Map<number, string>) => [...m.values()].sort((a, b) => a.localeCompare(b));
  const problems: string[] = [];
  if (listsBoth.size) {
    problems.push(
      `${some(names(listsBoth))} ${listsBoth.size === 1 ? "lists" : "list"} both as other vendors.`,
    );
  }
  if (ownAndOther.size) {
    problems.push(
      `${some(names(ownAndOther))} would list ${into.name} as both ${
        ownAndOther.size === 1 ? "its own vendor and another" : "their own vendor and another"
      }.`,
    );
  }
  return problems;
}

async function vendorOrThrow(tx: Tx, id: number, which: string): Promise<MergeVendor> {
  const vendor = await tx.vendor.findUnique({ where: { id }, select: VENDOR });
  if (!vendor) throw new VendorMergeError(`The vendor to ${which} doesn't exist.`, 404);
  return vendor;
}

/** What merging `fromId` into `intoId` would move, take and refuse. Writes nothing. */
export async function planVendorMerge(
  db: Tx,
  fromId: number,
  intoId: number,
): Promise<VendorMergePreview> {
  const isId = (id: number) => Number.isInteger(id) && id > 0;
  if (!isId(fromId) || !isId(intoId)) throw new VendorMergeError("Choose a vendor to merge into.");
  if (fromId === intoId) throw new VendorMergeError("Choose a different vendor to merge into.");
  const from = await vendorOrThrow(db, fromId, "merge");
  const into = await vendorOrThrow(db, intoId, "merge into");

  const counts = await Promise.all(
    MOVED.map(async ([model, one, many]) => {
      const count = await delegate(db, model).count({ where: { vendorId: from.id } });
      return { label: count === 1 ? one : many, count };
    }),
  );

  const problems: string[] = [];
  if (from.isConsignment !== into.isConsignment) {
    const [consignor, other] = from.isConsignment ? [from, into] : [into, from];
    problems.push(
      `${consignor.name} takes goods on consignment and ${other.name} doesn't, so their items are owned and paid for differently.`,
    );
  }
  problems.push(...(await keyedClashes(db, from.id, into.id)));
  problems.push(...(await sourceClashes(db, from, into)));
  const rules = await db.commissionPlanRule.findMany({
    where: { vendorId: from.id },
    select: { label: true, plan: { select: { name: true } } },
    orderBy: { id: "asc" },
  });
  if (rules.length) {
    const named = rules.map((r) => `"${r.label}" in ${r.plan.name}`);
    problems.push(
      `${rules.length === 1 ? "A commission rule is" : "Commission rules are"} for ${from.name}: ${some(named)}. Change or remove ${rules.length === 1 ? "it" : "them"} first, so the merge doesn't change what anyone earns.`,
    );
  }

  return {
    from: { id: from.id, name: from.name },
    into: { id: into.id, name: into.name },
    moves: counts.filter((c) => c.count > 0),
    takes: TAKEN.filter(([field]) => isBlank(into[field]) && !isBlank(from[field])).map(
      ([, label]) => label,
    ),
    problems,
  };
}

/**
 * Merge `fromId` into `intoId`, or refuse with every reason it can't. Returns
 * the plan it carried out.
 */
export async function mergeVendor(
  db: PrismaClient,
  fromId: number,
  intoId: number,
  by: string | null,
): Promise<VendorMergePreview> {
  try {
    const merged = await db.$transaction(async (tx) => {
      // Lock both vendors first. A row written against the duplicate meanwhile
      // (an import adding an item) waits for this to finish and then fails on
      // its foreign key, rather than landing between the moves and the delete.
      if (Number.isInteger(fromId) && Number.isInteger(intoId)) {
        await tx.$executeRaw`SELECT 1 FROM "Vendor" WHERE id IN (${fromId}, ${intoId}) ORDER BY id FOR UPDATE`;
      }
      const plan = await planVendorMerge(tx, fromId, intoId);
      if (plan.problems.length) {
        throw new VendorMergeError(
          `${plan.from.name} can't be merged into ${plan.into.name} yet.`,
          409,
          plan.problems,
        );
      }
      const from = await vendorOrThrow(tx, fromId, "merge");
      const into = await vendorOrThrow(tx, intoId, "merge into");

      // Collections have no foreign key, and a same-named pair folds into the
      // kept vendor's: its items and styles move over and the duplicate goes.
      const collections = await tx.collection.findMany({
        where: { vendorId: { in: [from.id, into.id] } },
        select: { id: true, vendorId: true, name: true },
      });
      const intoCollection = new Map(
        collections.filter((c) => c.vendorId === into.id).map((c) => [c.name, c.id]),
      );
      for (const c of collections.filter((c) => c.vendorId === from.id)) {
        const keep = intoCollection.get(c.name);
        if (keep === undefined) continue;
        await tx.product.updateMany({
          where: { collectionId: c.id },
          data: { collectionId: keep },
        });
        await tx.vendorStyle.updateMany({
          where: { collectionId: c.id },
          data: { collectionId: keep },
        });
        await tx.collection.delete({ where: { id: c.id } });
      }

      for (const [model] of MOVED) {
        await delegate(tx, model).updateMany({
          where: { vendorId: from.id },
          data: KEEPS_VENDOR_NAME.has(model)
            ? { vendorId: into.id, vendorName: into.name }
            : { vendorId: into.id },
        });
      }

      const data: Prisma.VendorUpdateInput = { updatedBy: by };
      for (const [field] of TAKEN) {
        if (isBlank(into[field]) && !isBlank(from[field])) {
          (data as Record<string, unknown>)[field] = from[field];
        }
      }
      if (!isBlank(from.notes)) {
        data.notes = isBlank(into.notes)
          ? from.notes
          : `${into.notes}\n\nFrom ${from.name}: ${from.notes}`;
      }
      // The code is unique, so the duplicate lets go of it before the kept
      // vendor takes it; deleting the duplicate comes after.
      if (data.code !== undefined) {
        await tx.vendor.update({ where: { id: from.id }, data: { code: null } });
      }
      await tx.vendor.update({ where: { id: into.id }, data });

      // A row naming the duplicate that MOVED missed would fail this delete
      // (RESTRICT), undoing the merge, or lose its vendor (SET NULL);
      // __tests__/vendorMergeCoverage.test.ts keeps MOVED complete.
      await tx.vendor.delete({ where: { id: from.id } });
      await tx.vendorAlias.upsert({
        where: { name: from.name },
        update: { vendorId: into.id, mergedVendorId: from.id, createdBy: by },
        create: { name: from.name, vendorId: into.id, mergedVendorId: from.id, createdBy: by },
      });
      return plan;
    }, TX_TIMEOUT.LONG);
    merges++;
    return merged;
  } catch (err) {
    if (err instanceof VendorMergeError) throw err;
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      (err.code === "P2002" || err.code === "P2003" || err.code === "P2034")
    ) {
      // Logged too: a P2003 on the delete is also what a vendor reference
      // missing from MOVED looks like.
      logError("Vendor merge rolled back", err, { fromId, intoId });
      throw new VendorMergeError(
        "Something changed while merging, so nothing was merged. Try again.",
        409,
      );
    }
    throw err;
  }
}
