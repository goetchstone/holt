// /app/src/hooks/useCustomerSearch.ts
//
// Shared hook for customer search-as-you-type. Replaces the duplicated
// debounce + fetch pattern found in quotes/new, pos, service/cases/new,
// and interactions/[id]. All four previously had their own 300ms setTimeout,
// their own useState triplet, and their own error swallowing.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { useDebounce } from "./useDebounce";

export interface CustomerSearchResult {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
}

interface UseCustomerSearchOptions {
  minLength?: number;
  debounceMs?: number;
  limit?: number;
}

interface UseCustomerSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  results: CustomerSearchResult[];
  isSearching: boolean;
  clear: () => void;
}

export function useCustomerSearch(options?: UseCustomerSearchOptions): UseCustomerSearchReturn {
  const minLength = options?.minLength ?? 2;
  const debounceMs = options?.debounceMs ?? 300;
  const limit = options?.limit ?? 10;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerSearchResult[]>([]);
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
      .get("/api/customers", { params: { search: debouncedQuery, limit } })
      .then((res) => {
        if (!cancelled) {
          const data = res.data;
          setResults(Array.isArray(data) ? data : data.data || data.customers || []);
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
