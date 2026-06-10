// /app/src/server/trpc/routers/billing.ts
//
// Authored-invoice procedures (composer + lifecycle). MANAGER/ADMIN — every
// procedure exposes or moves money. The whole router is behind the `billing`
// feature flag: disabled deployments get NOT_FOUND, mirroring how gated pages
// call notFound(). Logic lives in lib/billing/* so the REST PDF endpoint and
// the Stripe webhook share it.

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { roleProcedure } from "../trpc";
import { router } from "../trpc";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import {
  createDraftInvoice,
  updateDraftInvoice,
  deleteDraftInvoice,
  issueInvoice,
  voidInvoice,
  recordInvoicePayment,
  listInvoices,
  getInvoiceDetail,
} from "@/lib/billing/invoiceService";
import { createInvoicePaymentLink } from "@/lib/billing/invoiceStripe";
import { sendInvoiceEmail } from "@/lib/billing/invoiceEmail";
import { InvoiceValidationError } from "@/lib/billing/invoiceAuthoring";

const BILLING_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER"];

const lineInput = z.object({
  description: z.string().min(1).max(2000),
  quantity: z.number().positive(),
  unitPrice: z.number().min(0),
});

const draftInput = z.object({
  customerId: z.number().int().positive(),
  lines: z.array(lineInput).min(1).max(100),
  taxRate: z.number().min(0).max(0.5).optional(),
  dueDate: z.string().nullish(),
  notes: z.string().max(5000).nullish(),
});

async function requireBillingEnabled(): Promise<void> {
  const settings = await getAppSettings();
  if (!isFeatureEnabled(settings.features, "billing")) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Billing is not enabled." });
  }
}

/** Map service validation errors to BAD_REQUEST so the client toast shows the reason. */
async function translate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof InvoiceValidationError) {
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    }
    throw err;
  }
}

function parseDueDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(`${value}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid due date." });
  }
  return d;
}

export const billingRouter = router({
  list: roleProcedure(BILLING_ROLES)
    .input(
      z
        .object({
          status: z.enum(["DRAFT", "ISSUED", "PAID", "VOID"]).optional(),
          customerId: z.number().int().positive().optional(),
        })
        .nullish(),
    )
    .query(async ({ input }) => {
      await requireBillingEnabled();
      return listInvoices(input ?? {});
    }),

  detail: roleProcedure(BILLING_ROLES)
    .input(z.object({ id: z.number().int().positive() }))
    .query(async ({ input }) => {
      await requireBillingEnabled();
      return translate(() => getInvoiceDetail(input.id));
    }),

  create: roleProcedure(BILLING_ROLES)
    .input(draftInput)
    .mutation(async ({ input, ctx }) => {
      await requireBillingEnabled();
      return translate(() =>
        createDraftInvoice({
          customerId: input.customerId,
          lines: input.lines,
          taxRate: input.taxRate,
          dueDate: parseDueDate(input.dueDate),
          notes: input.notes ?? null,
          createdBy: ctx.userEmail ?? null,
        }),
      );
    }),

  update: roleProcedure(BILLING_ROLES)
    .input(draftInput.extend({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await requireBillingEnabled();
      return translate(() =>
        updateDraftInvoice(input.id, {
          customerId: input.customerId,
          lines: input.lines,
          taxRate: input.taxRate,
          dueDate: parseDueDate(input.dueDate),
          notes: input.notes ?? null,
          updatedBy: ctx.userEmail ?? null,
        }),
      );
    }),

  delete: roleProcedure(BILLING_ROLES)
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      await requireBillingEnabled();
      return translate(() => deleteDraftInvoice(input.id));
    }),

  issue: roleProcedure(BILLING_ROLES)
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await requireBillingEnabled();
      return translate(() => issueInvoice(input.id, ctx.userEmail ?? null));
    }),

  void: roleProcedure(BILLING_ROLES)
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await requireBillingEnabled();
      return translate(() => voidInvoice(input.id, ctx.userEmail ?? null));
    }),

  recordPayment: roleProcedure(BILLING_ROLES)
    .input(
      z.object({
        id: z.number().int().positive(),
        amount: z.number().positive(),
        method: z.enum(["CASH", "CARD", "CHECK", "WIRE", "ACH", "OTHER"]),
        reference: z.string().max(100).nullish(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await requireBillingEnabled();
      return translate(() =>
        recordInvoicePayment(input.id, {
          amount: input.amount,
          method: input.method,
          reference: input.reference ?? null,
          createdBy: ctx.userEmail ?? null,
        }),
      );
    }),

  paymentLink: roleProcedure(BILLING_ROLES)
    .input(z.object({ id: z.number().int().positive() }))
    .mutation(async ({ input, ctx }) => {
      await requireBillingEnabled();
      return translate(() => createInvoicePaymentLink(input.id, ctx.userEmail ?? null));
    }),

  sendEmail: roleProcedure(BILLING_ROLES)
    .input(
      z.object({
        id: z.number().int().positive(),
        includePaymentLink: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      await requireBillingEnabled();
      return translate(() =>
        sendInvoiceEmail(input.id, {
          includePaymentLink: input.includePaymentLink ?? true,
          requestedBy: ctx.userEmail ?? null,
        }),
      );
    }),
});
