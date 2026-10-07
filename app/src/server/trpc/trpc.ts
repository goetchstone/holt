// /app/src/server/trpc/trpc.ts
//
// tRPC core init for the merged product. superjson transformer so Date/Decimal
// round-trip. Four procedure tiers:
//   publicProcedure          — no auth
//   protectedProcedure       — requires a signed-in user
//   roleProcedure(...)       — requires an allowed role, using the SAME decision
//                              as the Pages Router requireAuthWithRole
//                              (resolveRoleListAccess); takes { also } like it
//   permissionProcedure(...) — requires a capability, using the SAME resolver as
//                              the Pages Router requirePermission
//                              (resolvePermissionAccess)
//
// Both re-read the ACTIVE StaffMember row from the DB (the JWT role can be
// stale, and says nothing about deactivation), and the live privileged count
// for the bootstrap safeguard, through the same resolvers as the Pages path.

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import {
  logPermissionDenial,
  logRoleListOutcome,
  resolvePermissionAccess,
  resolveRoleListAccess,
  type PermissionRequirement,
} from "@/lib/auth/permissionResolver";
import { assertKnownKeys, type GateOptions } from "@/lib/auth/gateOptions";
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
 * Gate a procedure to one or more roles. resolveRoleListAccess is the same
 * decision requireAuthWithRole and requirePage use: the staff row is read from
 * the DB (the JWT role can be stale), only an ACTIVE row counts, and no row
 * means no role unless the bootstrap safeguard applies. `options.also` keys are
 * answered from the same read and put on the context as `holds`, as
 * permissionProcedure does (e.g. WITH_COST, lib/auth/costVisibility.ts).
 */
export function roleProcedure(allowedRoles: string[], options?: GateOptions) {
  assertKnownKeys("roleProcedure", options?.also);
  return protectedProcedure.use(async ({ ctx, next }) => {
    const userId = ctx.userId as string;
    const result = await resolveRoleListAccess({
      userId,
      allowedRoles,
      impersonate: ctx.impersonate,
      also: options?.also,
    });
    logRoleListOutcome(userId, allowedRoles, result);

    if (!result.allowed) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Insufficient role." });
    }
    return next({ ctx: { ...ctx, role: result.effectiveUserRole, holds: result.holds } });
  });
}

/**
 * Gate a procedure on a capability. Same shape as roleProcedure, and the same
 * relationship to the Pages Router: both call resolvePermissionAccess, so
 * neither router can drift from the other (CLAUDE.md rule 42).
 *
 * It existed before it had a consumer, on purpose: the App Router side had to
 * land with the Pages Router side, or the first tRPC procedure wanting a
 * permission check would have grown its own (how the three disagreeing auth
 * systems this work replaces came about). The cost-bearing reports were its
 * first consumers (SEC-14).
 */
export function permissionProcedure(permission: PermissionRequirement, options?: GateOptions) {
  assertKnownKeys("permissionProcedure", options?.also);
  return protectedProcedure.use(async ({ ctx, next }) => {
    const userId = ctx.userId as string;
    const result = await resolvePermissionAccess({
      userId,
      permission,
      impersonate: ctx.impersonate,
      also: options?.also,
    });

    if (!result.allowed) {
      logPermissionDenial(userId, permission, result);
      throw new TRPCError({ code: "FORBIDDEN", message: "Insufficient permission." });
    }
    // `holds` answers the gate's `also` keys from the same read, as for the
    // Pages Router gates (e.g. WITH_COST, lib/auth/costVisibility.ts).
    return next({ ctx: { ...ctx, role: result.effectiveUserRole, holds: result.holds } });
  });
}
