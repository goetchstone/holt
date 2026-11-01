// /app/src/lib/customers/referrals.ts
//
// GAP-08: how a customer heard of the store, and who sent them (owner,
// 2026-11-01: both).
//
//   ReferralSource        the store's own list, set up in Settings > Referral
//                         sources -- no fixed set ships (a store's sources are
//                         its own: a magazine, a designer, a street sign). A
//                         source customers use is switched off, never deleted,
//                         so their record keeps it.
//   referredByCustomerId  the customer or trade account who sent them; never
//                         themselves.
//
// readReferral is the one check both customer writes (create and edit) apply,
// so neither can set a switched-off source or a customer that doesn't exist.

import type { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient;
type Db = PrismaClient | Tx;

/** A refusal the caller shows as it stands: 400, 404 or 409. */
export class ReferralError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "ReferralError";
  }
}

export const REFERRAL_SOURCE_NAME_MAX = 80;

export interface ReferralSourceInput {
  name?: unknown;
  isActive?: unknown;
  sortOrder?: unknown;
}

/** The store's referral sources, in order; `activeOnly` for a picker. */
export function listReferralSources(db: Db, opts: { activeOnly?: boolean } = {}) {
  return db.referralSource.findMany({
    where: opts.activeOnly ? { isActive: true } : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { customers: true } } },
  });
}

function readName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.trim() : "";
  if (!name) throw new ReferralError("Give the source a name.");
  if (name.length > REFERRAL_SOURCE_NAME_MAX) {
    throw new ReferralError(`Keep the name under ${REFERRAL_SOURCE_NAME_MAX} characters.`);
  }
  return name;
}

function readOptionalFlags(input: ReferralSourceInput): {
  isActive?: boolean;
  sortOrder?: number;
} {
  const out: { isActive?: boolean; sortOrder?: number } = {};
  if (input.isActive !== undefined) {
    if (typeof input.isActive !== "boolean")
      throw new ReferralError("isActive must be true or false.");
    out.isActive = input.isActive;
  }
  if (input.sortOrder !== undefined) {
    if (typeof input.sortOrder !== "number" || !Number.isInteger(input.sortOrder)) {
      throw new ReferralError("sortOrder must be a whole number.");
    }
    out.sortOrder = input.sortOrder;
  }
  return out;
}

async function assertNameFree(db: Db, name: string, exceptId?: number): Promise<void> {
  const clash = await db.referralSource.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new ReferralError(`There is already a source called "${name}".`, 409);
}

export async function createReferralSource(db: Tx, input: ReferralSourceInput, by: string | null) {
  const name = readName(input.name);
  await assertNameFree(db, name);
  return db.referralSource.create({
    data: { name, ...readOptionalFlags(input), createdBy: by },
  });
}

export async function updateReferralSource(
  db: Tx,
  id: number,
  input: ReferralSourceInput,
  by: string | null,
) {
  const current = await db.referralSource.findUnique({ where: { id }, select: { id: true } });
  if (!current) throw new ReferralError("Referral source not found.", 404);
  const name = input.name === undefined ? undefined : readName(input.name);
  if (name !== undefined) await assertNameFree(db, name, id);
  return db.referralSource.update({
    where: { id },
    data: { ...(name !== undefined ? { name } : {}), ...readOptionalFlags(input), updatedBy: by },
  });
}

/** Delete a source no customer has; one in use is switched off instead. */
export async function deleteReferralSource(db: Tx, id: number): Promise<void> {
  const current = await db.referralSource.findUnique({
    where: { id },
    include: { _count: { select: { customers: true } } },
  });
  if (!current) throw new ReferralError("Referral source not found.", 404);
  if (current._count.customers > 0) {
    throw new ReferralError(
      `${current._count.customers} customer(s) heard of you through "${current.name}". Switch it off instead, so their records keep it.`,
      409,
    );
  }
  await db.referralSource.delete({ where: { id } });
}

async function readSourceId(
  db: Db,
  raw: unknown,
  customer: { referralSourceId: number | null } | null,
): Promise<number | null> {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new ReferralError("referralSourceId must be a referral source id, or null.");
  }
  const source = await db.referralSource.findUnique({
    where: { id: raw },
    select: { id: true, name: true, isActive: true },
  });
  if (!source) throw new ReferralError("That referral source doesn't exist.");
  // A switched-off source is kept by the customers who have it, and offered to
  // nobody new.
  if (!source.isActive && customer?.referralSourceId !== raw) {
    throw new ReferralError(`"${source.name}" is switched off in Settings.`);
  }
  return raw;
}

async function readReferrerId(
  db: Db,
  raw: unknown,
  customer: { id: number } | null,
): Promise<number | null> {
  if (raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    throw new ReferralError("referredByCustomerId must be a customer id, or null.");
  }
  if (customer && raw === customer.id) {
    throw new ReferralError("A customer can't be referred by themselves.");
  }
  const referrer = await db.customer.findUnique({ where: { id: raw }, select: { id: true } });
  if (!referrer) throw new ReferralError("The referring customer doesn't exist.");
  return raw;
}

/**
 * The referral fields of a customer write, checked: a source that exists and is
 * on (or the one the customer already has), and a referring customer that
 * exists and isn't the customer. Absent fields are left as they are; null
 * clears.
 */
export async function readReferral(
  db: Db,
  body: { referralSourceId?: unknown; referredByCustomerId?: unknown },
  customer: { id: number; referralSourceId: number | null } | null,
): Promise<{ referralSourceId?: number | null; referredByCustomerId?: number | null }> {
  return {
    ...(body.referralSourceId !== undefined
      ? { referralSourceId: await readSourceId(db, body.referralSourceId, customer) }
      : {}),
    ...(body.referredByCustomerId !== undefined
      ? { referredByCustomerId: await readReferrerId(db, body.referredByCustomerId, customer) }
      : {}),
  };
}
