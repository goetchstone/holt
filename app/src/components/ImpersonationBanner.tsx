// /app/src/components/ImpersonationBanner.tsx
//
// Global impersonation banner. Renders at the top of every page (wired
// into _app.tsx) so an ADMIN who started impersonating can always click
// Stop, no matter which layout they're on.
//
// Origin: 2026-04-30 — user impersonated REGISTER, navigated to a
// ScannerLayout page (no TopNav), and was locked in because the only
// "Stop Impersonating" button lived inside TopNav.

import { useEffectiveRole } from "@/lib/hooks/useEffectiveRole";

// Hoisted out of the component (S7721) — closes over no component state.
async function stopImpersonation(): Promise<void> {
  try {
    await fetch("/api/admin/impersonate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: null }),
    });
  } finally {
    // Belt-and-suspenders: also clear the cookie client-side. Even if
    // the server response is somehow malformed, the user's escape hatch
    // must still work. document.cookie deletion needs the same Path
    // attribute the cookie was set with.
    if (typeof document !== "undefined") {
      document.cookie = "sh-impersonate=; Path=/; Max-Age=0; SameSite=Lax";
    }
    globalThis.location.reload();
  }
}

export default function ImpersonationBanner() {
  const { isImpersonating, impersonatedRole } = useEffectiveRole();

  if (!isImpersonating) return null;

  return (
    <div className="bg-amber-100 border-b border-amber-300 px-8 py-2 flex items-center justify-between sticky top-0 z-50">
      <span className="text-sm font-semibold text-amber-800 font-serif">
        Viewing as {impersonatedRole}
      </span>
      <button
        type="button"
        onClick={stopImpersonation}
        className="text-sm font-semibold text-amber-800 underline hover:text-amber-900 min-h-[44px] px-3 font-serif"
      >
        Stop Impersonating
      </button>
    </div>
  );
}
