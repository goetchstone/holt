// /app/src/lib/hooks/useEffectiveRole.ts
//
// Returns the effective role for the current user. If the user may View as
// (their own role holds a key of IMPERSONATE) and has an active impersonation
// cookie, returns the impersonated role instead.

import { useSession } from "next-auth/react";
import { useState, useEffect } from "react";
import { resolveViewerPermissions } from "@/lib/auth/navPermissions";
import { mayImpersonate } from "@/lib/auth/roleDecision";

const COOKIE_NAME = "holt-impersonate";

// Cookie lookup without RegExp -- avoids the Semgrep detect-non-literal-
// regexp warning (though the input was a literal constant anyway) and is
// a bit clearer to read.
// Returns null for "no cookie" AND for "cookie present but empty value."
// The empty case happens after an attempted clear: if the Set-Cookie
// response is malformed (the missing-semicolon-before-Max-Age bug fixed
// 2026-04-30), the browser resets the value to "" but doesn't drop the
// cookie. Without this guard, isImpersonating stayed true and the user
// got stuck.
function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    if (trimmed.slice(0, eq) === name) {
      const value = decodeURIComponent(trimmed.slice(eq + 1));
      return value === "" ? null : value;
    }
  }
  return null;
}

export function useEffectiveRole(): {
  effectiveRole: string;
  realRole: string;
  isImpersonating: boolean;
  impersonatedRole: string | null;
} {
  const { data: session } = useSession();
  const realRole = (session as any)?.role || "DESIGNER";
  const [impersonatedRole, setImpersonatedRole] = useState<string | null>(null);

  useEffect(() => {
    setImpersonatedRole(getCookie(COOKIE_NAME));
  }, []);

  // Who may View as: the server's rule (IMPERSONATE in roleDecision.ts), read
  // from the session's keys, which are the REAL role's. A rule of its own here
  // would let the banner and the menu claim a View as the server ignores, or
  // hide one it applies. (A role-name copy of the rule once lost the Owner the
  // feature, 2026-05-19: it matched only "ADMIN".)
  const held = resolveViewerPermissions(session, null);
  const canImpersonate = mayImpersonate((key) => held.includes(key));
  const isImpersonating = canImpersonate && impersonatedRole !== null;
  const effectiveRole = isImpersonating ? impersonatedRole! : realRole;

  return { effectiveRole, realRole, isImpersonating, impersonatedRole };
}
