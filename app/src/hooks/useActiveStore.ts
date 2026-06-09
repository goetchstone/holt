// /app/src/hooks/useActiveStore.ts
//
// Hook for managing the current user's active store location.
// Returns the current store, a setter, and available stores.

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
  allStores: StoreInfo[];
  setActiveStore: (storeId: number) => Promise<void>;
  loading: boolean;
}

export function useActiveStore(): UseActiveStoreResult {
  const [activeStore, setActiveStoreState] = useState<StoreInfo | null>(null);
  const [allStores, setAllStores] = useState<StoreInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([axios.get("/api/staff/active-store"), axios.get("/api/warehouse/locations")])
      .then(([storeRes, locsRes]) => {
        setActiveStoreState(storeRes.data.activeStoreLocation || null);
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
    } catch {
      throw new Error("Failed to set active store");
    }
  }, []);

  return { activeStore, allStores, setActiveStore, loading };
}
