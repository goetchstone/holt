// /app/src/server/trpc/routers/clientPortal.ts
//
// Staff-side surface for the consultancy client portal: generate a
// customer's tokenized hub link (MANAGER/ADMIN — the link exposes invoices
// and appointment history). Gated on the `clientPortal` feature.

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { prisma } from "@/lib/prisma";
import { router } from "../trpc";
import { roleProcedure } from "../trpc";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import { generateClientPortalToken } from "@/lib/clientPortalToken";

const PORTAL_ROLES = ["SUPER_ADMIN", "ADMIN", "MANAGER"];

export const clientPortalRouter = router({
  generateLink: roleProcedure(PORTAL_ROLES)
    .input(z.object({ customerId: z.number().int().positive() }))
    .mutation(async ({ input }) => {
      const settings = await getAppSettings();
      if (!isFeatureEnabled(settings.features, "clientPortal")) {
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
