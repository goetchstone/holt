// /app/src/lib/auth/requirePage.ts
//
// Server-side auth gate for App Router pages (server components). Mirrors the
// Pages Router withAuth + requireAuthWithRole using the SAME shared
// decideRoleAccess rule, reading the session from the JWT via getToken (the
// reliable v4 path in the App Router, where there's no req/res). Redirects to
// /auth/login when unauthenticated, or home when the role is insufficient.

import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { getToken } from "next-auth/jwt";
import { prisma } from "@/lib/prisma";
import { decideRoleAccess } from "@/lib/auth/roleDecision";
import { getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";

export interface RequirePageOptions {
  /** Feature-module key (lib/featureCatalog.ts) that must be enabled in
   *  AppSettings.features for this page; redirects home when disabled. Mirrors
   *  the Pages-Router withAuth `feature` option. */
  feature?: string;
}

export interface PageSession {
  userId: string;
  role: string;
}

/**
 * Resolve the signed-in user for an App Router server component, enforcing an
 * optional allowed-roles list. Returns { userId, role } when allowed; otherwise
 * redirects (never returns). Pass no roles to require only that the user is
 * signed in.
 */
export async function requirePage(
  allowedRoles?: string[],
  options?: RequirePageOptions,
): Promise<PageSession> {
  // getToken reads + verifies the NextAuth JWT from the request cookies. In the
  // App Router we hand it a minimal { cookies, headers } shim built from the
  // next/headers async stores.
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
  if (options?.feature) {
    const settings = await getAppSettings();
    if (!isFeatureEnabled(settings.features, options.feature)) {
      redirect("/app");
    }
  }

  if (!allowedRoles || allowedRoles.length === 0) {
    return { userId, role: (token?.role as string | undefined) ?? "DESIGNER" };
  }

  const staff = await prisma.staffMember.findFirst({
    where: { userId },
    select: { role: true },
  });
  const privilegedCount = await prisma.staffMember.count({
    where: {
      role: { in: ["SUPER_ADMIN", "ADMIN", "MANAGER"] },
      isActive: true,
      userId: { not: null },
    },
  });
  const impersonate = cookieStore.get("sh-impersonate")?.value ?? null;

  const decision = decideRoleAccess({
    allowedRoles,
    realRole: staff?.role || "DESIGNER",
    impersonate,
    privilegedCount,
  });

  if (!decision.allowed) {
    redirect("/app");
  }
  return { userId, role: decision.effectiveUserRole };
}
