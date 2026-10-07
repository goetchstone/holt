// /app/src/lib/auth/requirePage.ts
//
// Server-side auth gate for App Router pages (server components). Mirrors the
// Pages Router withAuth + requireAuthWithRole using the SAME shared
// resolveRoleListAccess decision, reading the session from the JWT via getToken (the
// reliable v4 path in the App Router, where there's no req/res). Redirects to
// /auth/login when unauthenticated, or home when the role is insufficient.

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getToken } from "next-auth/jwt";
import {
  logRoleListOutcome,
  resolvePermissionAccess,
  resolveRoleListAccess,
} from "@/lib/auth/permissionResolver";
import { isModuleEnabled } from "@/lib/modules/requireModule";
import { assertKnownKeys } from "@/lib/auth/gateOptions";

export interface RequirePageOptions {
  /** Feature-module key (lib/featureCatalog.ts) that must be enabled in
   *  AppSettings.features for this page; redirects home when disabled. Mirrors
   *  the Pages-Router withAuth `feature` option. */
  feature?: string;
  /**
   * Gate on a capability instead of a role list.
   *
   * Use this on any page whose nav entry is derived from a permission
   * (lib/auth/navPermissions.ts). The thing that shows the link then IS the
   * thing that admits the request -- otherwise the two drift and the menu grows
   * entries that bounce you straight back to /app, which is a worse experience
   * than no entry at all.
   *
   * Takes precedence over `allowedRoles` when both are given.
   */
  permission?: string;
  /** Permission keys to answer for the viewer beside the gate, without
   *  requiring them (see GateOptions in lib/auth/gateOptions.ts). Answered in
   *  `holds`, from the same staff read as the gate. */
  also?: readonly string[];
}

export interface PageSession {
  userId: string;
  role: string;
  /** For each key in `options.also`: does the viewer hold it? */
  holds: Readonly<Record<string, boolean>>;
}

/**
 * Resolve the signed-in user for an App Router server component, enforcing an
 * optional allowed-roles list. Returns { userId, role, holds } when allowed
 * (holds answers options.also); otherwise redirects (never returns). Pass no
 * roles to require only that the user is signed in.
 */
export async function requirePage(
  allowedRoles?: string[],
  options?: RequirePageOptions,
): Promise<PageSession> {
  // getToken reads + verifies the NextAuth JWT from the request cookies. In the
  // App Router we hand it a minimal { cookies, headers } shim built from the
  // next/headers async stores.
  assertKnownKeys("requirePage", options?.also);
  const cookieStore = await cookies();
  const headerStore = await headers();
  const token = await getToken({
    req: {
      headers: Object.fromEntries(headerStore.entries()),
      cookies: Object.fromEntries(cookieStore.getAll().map((c) => [c.name, c.value])),
    } as unknown as Parameters<typeof getToken>[0]["req"],
    secret: process.env.NEXTAUTH_SECRET,
  });

  const userId = (token?.id as string | undefined) ?? null;
  if (!userId) {
    redirect("/auth/login");
  }

  // Feature-module gate (mirrors withAuth `feature`): redirect home when the
  // module is disabled in AppSettings.features. Independent of role.
  if (options?.feature && !(await isModuleEnabled(options.feature))) {
    redirect("/app");
  }

  const impersonateCookie = cookieStore.get("holt-impersonate")?.value ?? null;

  // Capability gate. Shares resolvePermissionAccess with requirePermission, so
  // a page and its API routes cannot disagree about who may be here, and the
  // impersonation + bootstrap rules are the ones argued for once elsewhere
  // rather than a second copy (rule 42).
  if (options?.permission) {
    const access = await resolvePermissionAccess({
      userId,
      permission: options.permission,
      impersonate: impersonateCookie,
      also: options.also,
    });
    if (!access.allowed) {
      redirect("/app");
    }
    return { userId, role: access.effectiveUserRole, holds: access.holds };
  }

  if (!allowedRoles || allowedRoles.length === 0) {
    if (options?.also?.length) {
      // A signed-in-only page has no gate decision to ride on, so it would
      // have to answer keys for a caller nobody checked. Ask for a key gate.
      throw new Error("requirePage: { also } needs a permission or a roles list");
    }
    return { userId, role: (token?.role as string | undefined) ?? "DESIGNER", holds: {} };
  }

  // The same decision as requireAuthWithRole and roleProcedure: only an ACTIVE
  // staff row counts, and no row means no role unless the bootstrap safeguard
  // applies (resolveRoleListAccess).
  const decision = await resolveRoleListAccess({
    userId,
    allowedRoles,
    impersonate: impersonateCookie,
    also: options?.also,
  });
  logRoleListOutcome(userId, allowedRoles, decision);

  if (!decision.allowed) {
    redirect("/app");
  }
  return { userId, role: decision.effectiveUserRole, holds: decision.holds };
}
