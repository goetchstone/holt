"use client";

// /app/src/lib/hooks/useFeatures.ts
//
// Client hook exposing the deployment's resolved feature-module map (from
// /api/settings/features, AppSettings merged with catalog defaults). Lets client
// components (CardGrid hub/report cards) hide modules a tenant switched off, the
// same way the nav does via getVisibleNavItems. Until the fetch resolves, every
// feature reads as enabled to avoid a hide-flash on first paint.

import { useEffect, useState } from "react";
import { isFeatureEnabled } from "@/lib/featureCatalog";

export function useFeatures() {
  const [features, setFeatures] = useState<Record<string, boolean> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings/features")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) setFeatures((data.features ?? {}) as Record<string, boolean>);
      })
      .catch(() => {
        if (!cancelled) setFeatures({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // null = not loaded yet -> treat as enabled (no flash); else resolve via the
  // catalog so an unset key still honors its default.
  const enabled = (key: string): boolean =>
    features === null ? true : isFeatureEnabled(features, key);

  return { features, enabled, loaded: features !== null };
}
