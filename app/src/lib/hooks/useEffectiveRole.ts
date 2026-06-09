// /app/src/lib/hooks/useEffectiveRole.ts
//
// Returns the effective role for the current user. If the user is an ADMIN
// with an active impersonation cookie, returns the impersonated role instead.

import { useSession } from "next-auth/react";
import { useState, useEffect } from "react";

const COOKIE_NAME = "sh-impersonate";

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

  // SUPER_ADMIN + ADMIN can both impersonate. Origin 2026-05-19: first
  // SUPER_ADMIN login lost the impersonation feature because the gate
  // only matched "ADMIN".
  const canImpersonate = realRole === "SUPER_ADMIN" || realRole === "ADMIN";
  const isImpersonating = canImpersonate && impersonatedRole !== null;
  const effectiveRole = isImpersonating ? impersonatedRole! : realRole;

  return { effectiveRole, realRole, isImpersonating, impersonatedRole };
}
