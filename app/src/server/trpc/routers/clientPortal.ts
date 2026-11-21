// /app/src/server/trpc/routers/clientPortal.ts
//
// Staff-side surface for the consultancy client portal: generate a
// customer's tokenized hub link. The link exposes invoices and appointment
// history, and its one caller is Copy Portal Link on the invoice detail, so it
// takes the Invoices screens' key, "Bill customers directly"
// (accounting.invoice). Gated on the `clientPortal` feature.

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { prisma } from "@/lib/prisma";
import { router } from "../trpc";
import { permissionProcedure } from "../trpc";
import { isModuleEnabled } from "@/lib/modules/requireModule";
import { generateClientPortalToken } from "@/lib/clientPortalToken";

export const clientPortalRouter = router({
  generateLink: permissionProcedure("accounting.invoice")
    .input(z.object({ customerId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      if (!(await isModuleEnabled("clientPortal"))) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "The client portal module is not enabled.",
        });
      }
      const customer = await prisma.customer.findUnique({
        where: { id: input.customerId },
        select: { id: true },
      });
      if (!customer) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Customer not found." });
      }
      const token = generateClientPortalToken(input.customerId);
      const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
      return { url: `${baseUrl}/portal/client/${token}` };
    }),
});
