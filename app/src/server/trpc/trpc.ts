// /app/src/server/trpc/trpc.ts
//
// tRPC core init for the merged product. superjson transformer so Date/Decimal
// round-trip. Three procedure tiers:
//   publicProcedure    — no auth
//   protectedProcedure — requires a signed-in user
//   roleProcedure(...) — requires an allowed role, using the SAME decision as
//                        the Pages Router requireAuthWithRole (decideRoleAccess)
//
// Role resolution re-reads the StaffMember role from the DB (the JWT role can
// be stale) and the live privileged-count for the bootstrap safeguard, exactly
// mirroring the Pages path.

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { prisma } from "@/lib/prisma";
import { decideRoleAccess } from "@/lib/auth/roleDecision";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({ transformer: superjson });

export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign-in required." });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});

/**
 * Gate a procedure to one or more roles. Re-resolves the real role + privileged
 * count from the DB and defers the allow/deny call to the shared
 * decideRoleAccess so Pages and App Router enforce identical rules.
 */
export function roleProcedure(allowedRoles: string[]) {
  return protectedProcedure.use(async ({ ctx, next }) => {
    const staff = await prisma.staffMember.findFirst({
      where: { userId: ctx.userId as string },
      select: { role: true },
    });
    const privilegedCount = await prisma.staffMember.count({
      where: {
        role: { in: ["SUPER_ADMIN", "ADMIN", "MANAGER"] },
        isActive: true,
        userId: { not: null },
      },
    });

    const decision = decideRoleAccess({
      allowedRoles,
      realRole: staff?.role || "DESIGNER",
      impersonate: ctx.impersonate,
      privilegedCount,
    });

    if (!decision.allowed) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Insufficient role." });
    }
    return next({ ctx: { ...ctx, role: decision.effectiveUserRole } });
  });
}
