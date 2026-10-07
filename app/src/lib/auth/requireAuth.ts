// /app/src/lib/auth/requireAuth.ts
//
// API route authentication wrappers.
//
// requireAuth -- checks that the request has a valid session.
// requireAuthWithRole -- additionally checks that the user's StaffMember
//   role is in the allowed list, returning 403 if not. Includes bootstrap
//   safeguard: if no signed-in MANAGER exists, enforcement is skipped so
//   the first user can promote themselves via Admin > Staff.
// requirePermission -- the same shape, but gating on a CAPABILITY from
//   lib/auth/permissionCatalog.ts rather than a job title. This is where the
//   335 role-gated routes are headed; today exactly one route uses it (see
//   docs/domains/staff-auth.md for what is and is not enforced).

import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession, Session } from "next-auth";
import { authOptions } from "@/pages/api/auth/[...nextauth]";
import { prisma } from "@/lib/prisma";
import {
  logBootstrapBypass,
  logPermissionDenial,
  logRoleListOutcome,
  resolvePermissionAccess,
  resolveRoleListAccess,
  type PermissionRequirement,
} from "@/lib/auth/permissionResolver";
import { assertKnownKeys, type CallerAccess, type GateOptions } from "@/lib/auth/gateOptions";

type AuthenticatedHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
) => Promise<void | NextApiResponse>;

export type { CallerAccess, GateOptions } from "@/lib/auth/gateOptions";

/** A handler behind requirePermission / requireAuthWithRole. A three-argument
 *  handler that ignores `access` fits too. */
type GatedHandler = (
  req: NextApiRequest,
  res: NextApiResponse,
  session: Session,
  access: CallerAccess,
) => Promise<void | NextApiResponse>;

export function requireAuth(handler: AuthenticatedHandler) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const session = await getServerSession(req, res, authOptions);

    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    return handler(req, res, session);
  };
}

/**
 * The signed-in user's role RIGHT NOW, read from the database.
 *
 * Use this instead of `session.role` or `session.user.role`. Those come off the
 * JWT, which is minted at sign-in and not revisited: a staff member who is
 * demoted, or deactivated entirely, keeps whatever the token says until it
 * expires. That is the same hole resolveRoleListAccess closes for the role-list
 * gates -- offboarding that does not actually revoke anything -- and reading
 * the role off the session reopens it one route at a time.
 *
 * Returns null when there is no ACTIVE staff record, so callers deny by default.
 * Exists for routes that cannot simply wrap in requireAuthWithRole because they
 * also accept a machine Bearer token for cron.
 */
export async function activeStaffRole(
  session: { user?: { id?: string | null } | null } | null,
): Promise<string | null> {
  const userId = session?.user?.id;
  if (!userId) return null;
  const staff = await prisma.staffMember.findFirst({
    where: { userId, isActive: true },
    select: { role: true },
  });
  return staff?.role ?? null;
}

export function requireAuthWithRole(roles: string[], handler: GatedHandler, options?: GateOptions) {
  assertKnownKeys("requireAuthWithRole", options?.also);
  return requireAuth(async (req, res, session) => {
    const userId = (session.user as any)?.id;
    if (!userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    // The decision, isActive and the bootstrap safeguard included, is
    // resolveRoleListAccess: the same function behind roleProcedure and
    // requirePage, so the three role-list gates cannot drift apart again.
    const result = await resolveRoleListAccess({
      userId,
      allowedRoles: roles,
      impersonate: req.cookies?.["holt-impersonate"] || null,
      also: options?.also,
    });
    logRoleListOutcome(userId, roles, result);
    if (!result.allowed) {
      return res.status(403).json({ error: "Forbidden" });
    }

    return handler(req, res, session, { holds: result.holds });
  });
}

/**
 * Gate a Pages Router API route on a capability instead of a role list.
 *
 *   export default requirePermission("payment.refund", handler);
 *
 * A route that serves several screens takes the keys of those screens, and any
 * one of them admits the caller (see PermissionRequirement in roleDecision.ts):
 *
 *   export default requirePermission({ anyOf: ["sales.read", "reporting.read"] }, handler);
 *
 * Deliberately the same shape as requireAuthWithRole above so that converting a
 * route is a one-line mechanical edit, and deliberately NOT its own copy of the
 * rules: every decision is made by resolvePermissionAccess, which the tRPC
 * permissionProcedure also calls (CLAUDE.md rule 42 — one shared function on
 * every path, not one per router).
 *
 * The role is resolved from the database per request, never from the JWT: a
 * session's role is stale the moment someone is re-roled and says nothing about
 * isActive. Impersonation and the bootstrap safeguard behave exactly as they do
 * for requireAuthWithRole, because both go through the same pure decision
 * helpers in roleDecision.ts.
 */
export function requirePermission(
  permission: PermissionRequirement,
  handler: GatedHandler,
  options?: GateOptions,
) {
  // An empty list would admit nobody but the bootstrap safeguard: a typo in
  // code, refused when the route loads rather than at the first request.
  if (typeof permission !== "string" && permission.anyOf.length === 0) {
    throw new Error("requirePermission: an { anyOf } list needs at least one permission key");
  }
  assertKnownKeys("requirePermission", options?.also);
  return requireAuth(async (req, res, session) => {
    const userId = (session.user as any)?.id;
    if (!userId) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const result = await resolvePermissionAccess({
      userId,
      permission,
      impersonate: req.cookies?.["holt-impersonate"] || null,
      also: options?.also,
    });

    if (!result.allowed) {
      logPermissionDenial(userId, permission, result);
      return res.status(403).json({ error: "Forbidden" });
    }
    if (result.bootstrapBypass) {
      logBootstrapBypass(userId, permission, result);
    }

    return handler(req, res, session, { holds: result.holds });
  });
}
