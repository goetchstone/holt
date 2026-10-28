"use client";

// /app/src/lib/hooks/useGettingStartedRemaining.ts
//
// How many getting-started items (lib/gettingStarted.ts) are still to do, for
// the badge on the sidebar's Admin entry. Only asks when `enabled` -- the
// viewer holds admin.settings, the key /api/admin/getting-started is gated on
// -- so nobody else's sidebar makes a request that would 403.
//
// `refreshKey` re-runs the fetch when it changes. The sidebar passes the
// pathname: it lives in the persistent (dashboard) layout, so without this the
// badge would keep counting an item the admin finished two pages ago. 0 while
// loading and on any failure: a missing badge is the quiet direction, and the
// Admin hub's own card is the full answer.

import { useEffect, useState } from "react";

export function useGettingStartedRemaining(enabled: boolean, refreshKey?: unknown): number {
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    fetch("/api/admin/getting-started")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.remaining === "number") setRemaining(data.remaining);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey]);

  return enabled ? remaining : 0;
}
