// /app/src/lib/auth/withAuth.ts

import { getSession } from "next-auth/react";
import { GetServerSidePropsContext, GetServerSidePropsResult } from "next";
import { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { getPublicBranding, getAppSettings } from "@/lib/appSettings";
import { isFeatureEnabled } from "@/lib/featureCatalog";
import type { Branding } from "@/lib/branding";

// Merge resolved branding into a page's props so the client chrome renders
// the tenant's name/logo on first paint. Redirect / notFound results pass
// through untouched.
async function attachBranding<P>(
  result: GetServerSidePropsResult<P>,
  branding: Branding,
): Promise<GetServerSidePropsResult<P>> {
  if ("props" in result) {
    const props = await result.props;
    return { ...result, props: { ...props, branding } };
  }
  return result;
}

interface WithAuthOptions {
  callbackUrl?: string;
  roles?: string[];
  /**
   * Feature-module key (from lib/featureCatalog.ts) that must be enabled for
   * this page. When the module is disabled in AppSettings.features, the page
   * redirects home -- the server-side counterpart to nav hiding, so a disabled
   * module can't be reached by typing its URL.
   */
  feature?: string;
}

/**
 * Resolve the effective role to check against `options.roles`.
 *
 * - The real role comes from the JWT session (`session.role`, defaulting
 *   to DESIGNER if unset).
 * - SUPER_ADMIN and ADMIN can impersonate other roles via the
 *   `sh-impersonate` cookie; the impersonated role replaces the real
 *   role for the check.
 */
function resolveEffectiveRole(session: Session, ctx: GetServerSidePropsContext): string {
  const realRole = (session as unknown as { role?: string }).role || "DESIGNER";
  const impersonate = ctx.req.cookies?.["sh-impersonate"] || null;
  const canImpersonate = realRole === "SUPER_ADMIN" || realRole === "ADMIN";
  return canImpersonate && impersonate ? impersonate : realRole;
}

/**
 * SUPER_ADMIN auto-promotion: any check requiring ADMIN is automatically
 * satisfied by SUPER_ADMIN (strictly more privileged). Pages that gate
 * on `["ADMIN"]` should let SUPER_ADMIN through without naming them
 * explicitly.
 */
function isAuthorized(userRole: string, allowedRoles: readonly string[]): boolean {
  if (allowedRoles.includes(userRole)) return true;
  if (userRole === "SUPER_ADMIN" && allowedRoles.includes("ADMIN")) return true;
  return false;
}

/**
 * Bootstrap safeguard: don't enforce role gates until at least one real
 * privileged user has signed in. Seeded staff who never logged in don't
 * count (no `userId` linkage to a NextAuth account).
 *
 * If the DB check fails (transient connection issue, etc.) we fail open
 * — allowing access is safer than locking the owner out during an
 * incident.
 */
async function hasAnyPrivilegedUser(): Promise<boolean> {
  try {
    const count = await prisma.staffMember.count({
      where: {
        role: { in: ["SUPER_ADMIN", "ADMIN", "MANAGER"] },
        isActive: true,
        userId: { not: null },
      },
    });
    return count > 0;
  } catch {
    return false;
  }
}

export function withAuth<P>(
  getServerSidePropsFunc?: (ctx: GetServerSidePropsContext) => Promise<GetServerSidePropsResult<P>>,
  options?: WithAuthOptions,
) {
  return async (ctx: GetServerSidePropsContext): Promise<GetServerSidePropsResult<any>> => {
    const session = await getSession(ctx);

    if (!session) {
      const callbackUrl = options?.callbackUrl || ctx.resolvedUrl;
      return {
        redirect: {
          destination: `/auth/login?callbackUrl=${encodeURIComponent(callbackUrl)}`,
          permanent: false,
        },
      };
    }

    if (options?.roles && options.roles.length > 0) {
      const userRole = resolveEffectiveRole(session, ctx);
      if (!isAuthorized(userRole, options.roles) && (await hasAnyPrivilegedUser())) {
        return { redirect: { destination: "/", permanent: false } };
      }
    }

    if (options?.feature) {
      const settings = await getAppSettings();
      if (!isFeatureEnabled(settings.features, options.feature)) {
        return { redirect: { destination: "/", permanent: false } };
      }
    }

    const branding = await getPublicBranding();

    if (getServerSidePropsFunc) {
      return await attachBranding(await getServerSidePropsFunc(ctx), branding);
    }

    return { props: { session, branding } };
  };
}
