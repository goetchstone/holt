// /app/src/lib/payments/tenders.ts
//
// The tenders a store sets up for itself (Settings -> Payment Types): each
// finance company, Zelle, a trade-in. The contract the screens share is
// tenderShared.ts; this file enforces it and is the one place a payment is
// labelled from a store tender.
//
// A store tender's payments carry its NAME as their `paymentType`, which is the
// label the sales journal maps to a GL account (lib/journalEntry.ts) and the
// reconciliation counts as tender (lib/dailyReconciliation.ts). So the tender
// and its POS_PAYMENTS mapping are made together, the mapping starting on the
// account its kind already books to, and the name and kind are fixed once a
// payment uses the tender: changing either would split its history from its
// account. Switching a tender off keeps its history and stops it being offered.

import type { PaymentMethod, Prisma } from "@prisma/client";
import { METHOD_DISPLAY } from "@/lib/paymentMethodDisplay";
import { POS_PAYMENTS_SECTION } from "@/lib/glMapping";
import {
  isTenderKind,
  REFERENCE_MAX,
  tenderNameProblem,
  type TenderKind,
} from "@/lib/payments/tenderShared";

type Client = Prisma.TransactionClient;

/** A refusal the caller shows as it stands: 400, 404 or 409. */
export class TenderError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
    this.name = "TenderError";
  }
}

export interface TenderInput {
  name?: unknown;
  kind?: unknown;
  isActive?: unknown;
  atRegister?: unknown;
  onInvoices?: unknown;
  referenceRequired?: unknown;
  sortOrder?: unknown;
}

const FLAGS = ["isActive", "atRegister", "onInvoices", "referenceRequired"] as const;

const OFFERED_ON = {
  register: { isActive: true, atRegister: true },
  invoices: { isActive: true, onInvoices: true },
} as const;

/** The tenders a surface offers, in order; with no surface, every tender. */
export async function listTenders(client: Client, surface?: keyof typeof OFFERED_ON) {
  return client.tender.findMany({
    where: surface ? OFFERED_ON[surface] : {},
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { payments: true } } },
  });
}

/** Each tender's POS_PAYMENTS account, for the Settings list. */
export async function tenderAccounts(client: Client, names: string[]) {
  const rows = await client.systemGLMapping.findMany({
    where: { section: POS_PAYMENTS_SECTION, label: { in: names } },
    select: { label: true, glAccount: { select: { code: true, name: true } } },
  });
  return new Map(rows.map((r) => [r.label, r.glAccount]));
}

async function assertNameFree(client: Client, name: string, exceptId?: number) {
  const taken = await client.tender.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptId != null && { id: { not: exceptId } }),
    },
    select: { id: true },
  });
  if (taken) throw new TenderError(`There is already a payment type named "${name}".`, 409);
}

function readName(raw: unknown): string {
  if (typeof raw !== "string") throw new TenderError("Name the payment type.");
  const problem = tenderNameProblem(raw);
  if (problem) throw new TenderError(problem);
  return raw.trim();
}

function readKind(raw: unknown): TenderKind {
  if (!isTenderKind(raw)) {
    throw new TenderError("A payment type is a Finance, Wire, ACH or Other kind.");
  }
  return raw;
}

function readFlags(input: TenderInput) {
  const flags: Partial<Record<(typeof FLAGS)[number], boolean>> = {};
  for (const key of FLAGS) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new TenderError(`${key} must be true or false.`);
    flags[key] = value;
  }
  let sortOrder: number | undefined;
  if (input.sortOrder !== undefined) {
    if (typeof input.sortOrder !== "number" || !Number.isInteger(input.sortOrder)) {
      throw new TenderError("Sort order must be a whole number.");
    }
    sortOrder = input.sortOrder;
  }
  return { ...flags, ...(sortOrder !== undefined && { sortOrder }) };
}

/**
 * The POS_PAYMENTS mapping a new tender's payments book through. One already
 * there under the name (an imported tender string the store mapped) is kept as
 * it is; otherwise it starts on the account the tender's kind books to, so
 * nothing taken with it is dropped from the journal before anyone looks.
 */
async function ensureMapping(client: Client, name: string, kind: TenderKind, by: string | null) {
  const existing = await client.systemGLMapping.findUnique({
    where: { section_label: { section: POS_PAYMENTS_SECTION, label: name } },
    select: { id: true },
  });
  if (existing) return;
  const kindMapping = await client.systemGLMapping.findUnique({
    where: { section_label: { section: POS_PAYMENTS_SECTION, label: METHOD_DISPLAY[kind] } },
    select: { glAccountId: true },
  });
  await client.systemGLMapping.create({
    data: {
      section: POS_PAYMENTS_SECTION,
      label: name,
      glAccountId: kindMapping?.glAccountId ?? null,
      createdBy: by,
    },
  });
}

export async function createTender(client: Client, input: TenderInput, by: string | null) {
  const name = readName(input.name);
  const kind = readKind(input.kind);
  const flags = readFlags(input);
  await assertNameFree(client, name);
  const tender = await client.tender.create({
    data: { name, kind, ...flags, createdBy: by },
  });
  await ensureMapping(client, name, kind, by);
  return tender;
}

export async function updateTender(
  client: Client,
  id: number,
  input: TenderInput,
  by: string | null,
) {
  const current = await client.tender.findUnique({
    where: { id },
    include: { _count: { select: { payments: true } } },
  });
  if (!current) throw new TenderError("Payment type not found.", 404);

  const name = input.name === undefined ? current.name : readName(input.name);
  const kind = input.kind === undefined ? (current.kind as TenderKind) : readKind(input.kind);
  const renamed = name !== current.name;
  if ((renamed || kind !== current.kind) && current._count.payments > 0) {
    throw new TenderError(
      `${current._count.payments} payment(s) were taken as "${current.name}", so its name and kind are fixed. Switch it off and add a new payment type instead.`,
      409,
    );
  }
  if (renamed) {
    await assertNameFree(client, name, id);
    await client.systemGLMapping.deleteMany({
      where: { section: POS_PAYMENTS_SECTION, label: current.name },
    });
  }
  const tender = await client.tender.update({
    where: { id },
    data: { name, kind, ...readFlags(input), updatedBy: by },
  });
  if (renamed || kind !== current.kind) await ensureMapping(client, name, kind, by);
  return tender;
}

/**
 * Delete a tender nothing was paid with, and its mapping unless another
 * payment (an imported one) carries the same label. One with payments is
 * switched off instead, so its history keeps its name and account.
 */
export async function deleteTender(client: Client, id: number) {
  const current = await client.tender.findUnique({
    where: { id },
    include: { _count: { select: { payments: true } } },
  });
  if (!current) throw new TenderError("Payment type not found.", 404);
  if (current._count.payments > 0) {
    throw new TenderError(
      `${current._count.payments} payment(s) were taken as "${current.name}". Switch it off instead, so it is no longer offered and its history stays.`,
      409,
    );
  }
  await client.tender.delete({ where: { id } });
  const labelled = await client.payment.count({
    where: { paymentType: { equals: current.name, mode: "insensitive" } },
  });
  if (labelled === 0) {
    await client.systemGLMapping.deleteMany({
      where: { section: POS_PAYMENTS_SECTION, label: current.name },
    });
  }
}

export interface TenderPayment {
  tenderId: number;
  method: PaymentMethod;
  paymentType: string;
  reference: string | null;
}

/**
 * How a payment taken with store tender `tenderId` is recorded: its kind as
 * the method, its name as the label. Every writer of a store-tender payment
 * goes through here -- the register's (paymentService.recordPaymentTx) and the
 * invoice screen's (invoiceService.recordInvoicePayment) -- so a switched-off
 * tender or a missing reference is refused the same way on both.
 */
export async function resolveTenderPayment(
  client: Client,
  tenderId: number,
  reference: string | null | undefined,
): Promise<TenderPayment> {
  const tender = await client.tender.findUnique({ where: { id: tenderId } });
  if (!tender) throw new TenderError("Payment type not found.");
  if (!tender.isActive) {
    throw new TenderError(`"${tender.name}" is switched off in Settings -> Payment Types.`);
  }
  const ref = reference?.trim() || null;
  if (ref && ref.length > REFERENCE_MAX) {
    throw new TenderError(`A reference can be at most ${REFERENCE_MAX} characters.`);
  }
  if (tender.referenceRequired && !ref) {
    throw new TenderError(`Enter the ${tender.name} reference (the approval or contract number).`);
  }
  return { tenderId: tender.id, method: tender.kind, paymentType: tender.name, reference: ref };
}
