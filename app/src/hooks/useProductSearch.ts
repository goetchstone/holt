// /app/src/hooks/useProductSearch.ts
//
// Shared hook for product search-as-you-type. Replaces the duplicated
// debounce + fetch pattern in quotes/new, pos, warehouse/transfers/new,
// and inventory/reconcile-photos. All had their own 300ms setTimeout
// and manual cleanup logic.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { useDebounce } from "./useDebounce";

export interface ProductSearchResult {
  id: number;
  productNumber: string;
  name: string;
  baseRetail?: number | null;
  baseCost?: number | null;
  vendorName?: string;
  departmentName?: string;
  categoryName?: string;
}

interface UseProductSearchOptions {
  minLength?: number;
  debounceMs?: number;
  limit?: number;
}

interface UseProductSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  results: ProductSearchResult[];
  isSearching: boolean;
  clear: () => void;
}

export function useProductSearch(options?: UseProductSearchOptions): UseProductSearchReturn {
  const minLength = options?.minLength ?? 2;
  const debounceMs = options?.debounceMs ?? 300;
  const limit = options?.limit ?? 15;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const debouncedQuery = useDebounce(query, debounceMs);

  useEffect(() => {
    if (debouncedQuery.length < minLength) {
      setResults([]);
      return;
    }

    let cancelled = false;
    setIsSearching(true);

    axios
      .get("/api/products", { params: { search: debouncedQuery, limit } })
      .then((res) => {
        if (!cancelled) {
          const data = res.data;
          setResults(Array.isArray(data) ? data : data.products || []);
        }
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setIsSearching(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, minLength, limit]);

  const clear = useCallback(() => {
    setQuery("");
    setResults([]);
  }, []);

  return { query, setQuery, results, isSearching, clear };
}
