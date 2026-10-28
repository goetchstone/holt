// /app/src/hooks/useActiveStore.ts
//
// Hook for managing the current user's active store location.
// Returns the current store, a setter, and available stores -- and whether a
// sale at the active store resolves a tax district (see
// pages/api/staff/active-store.ts), for the 0%-tax banner on POS and New Quote.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";

interface StoreInfo {
  id: number;
  name: string;
  code: string;
  type: string;
}

interface UseActiveStoreResult {
  activeStore: StoreInfo | null;
  /** false = a sale here is charged 0% tax (no store or default district);
   *  null until the server has answered. */
  taxDistrictConfigured: boolean | null;
  allStores: StoreInfo[];
  setActiveStore: (storeId: number) => Promise<void>;
  loading: boolean;
}

export function useActiveStore(): UseActiveStoreResult {
  const [activeStore, setActiveStoreState] = useState<StoreInfo | null>(null);
  const [taxDistrictConfigured, setTaxDistrictConfigured] = useState<boolean | null>(null);
  const [allStores, setAllStores] = useState<StoreInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([axios.get("/api/staff/active-store"), axios.get("/api/store-locations")])
      .then(([storeRes, locsRes]) => {
        setActiveStoreState(storeRes.data.activeStoreLocation || null);
        setTaxDistrictConfigured(readTaxDistrictConfigured(storeRes.data));
        const locs = (locsRes.data.locations || [])
          .filter((l: StoreInfo & { isActive: boolean }) => l.isActive)
          .map((l: StoreInfo) => ({ id: l.id, name: l.name, code: l.code, type: l.type }));
        setAllStores(locs);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const setActiveStore = useCallback(async (storeId: number) => {
    try {
      const res = await axios.put("/api/staff/active-store", { storeLocationId: storeId });
      setActiveStoreState(res.data.activeStoreLocation);
      setTaxDistrictConfigured(readTaxDistrictConfigured(res.data));
    } catch {
      throw new Error("Failed to set active store");
    }
  }, []);

  return { activeStore, taxDistrictConfigured, allStores, setActiveStore, loading };
}

function readTaxDistrictConfigured(data: unknown): boolean | null {
  const value = (data as { taxDistrictConfigured?: unknown } | null)?.taxDistrictConfigured;
  return typeof value === "boolean" ? value : null;
}
