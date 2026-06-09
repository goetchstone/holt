// /app/src/hooks/useStoreLocations.ts
//
// Fetches the deployment's store locations from the database (StoreLocation
// table) so UI dropdowns and dashboards never hardcode store names. Every
// tenant configures their own stores under Admin > Setup > Stores; this hook
// is the single client-side reader of that list.

import { useEffect, useState } from "react";

export interface StoreLocationOption {
  id: number;
  name: string;
  code: string;
  type: string;
}

interface UseStoreLocationsOptions {
  /** Only return active locations (default true). */
  activeOnly?: boolean;
  /** Filter to a single location type, e.g. "STORE" or "WAREHOUSE". */
  type?: string;
}

/**
 * Returns the configured store locations plus loading state. Falls back to an
 * empty list on error so callers render an empty dropdown rather than crashing.
 */
export function useStoreLocations(options: UseStoreLocationsOptions = {}): {
  stores: StoreLocationOption[];
  loading: boolean;
} {
  const { activeOnly = true, type } = options;
  const [stores, setStores] = useState<StoreLocationOption[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (type) params.set("type", type);
    if (activeOnly) params.set("isActive", "true");

    async function load() {
      try {
        const res = await fetch(`/api/warehouse/locations?${params.toString()}`);
        if (!res.ok) {
          if (!cancelled) setStores([]);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setStores(Array.isArray(data.locations) ? data.locations : []);
        }
      } catch {
        if (!cancelled) setStores([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [activeOnly, type]);

  return { stores, loading };
}
