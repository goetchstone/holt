// /app/src/hooks/useCustomerSearch.ts
//
// Shared hook for customer search-as-you-type. Replaces the duplicated
// debounce + fetch pattern found in quotes/new, pos, service/cases/new,
// interactions/[id], service/house-calls/new and the order page's customer
// field. Each previously had its own setTimeout, its own useState triplet, and
// its own error swallowing.

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

/**
 * The matches in a GET /api/customers answer, which is `{ data, totalPages }`.
 * Two screens that read `customers` instead never showed a match (2026-11-03).
 */
export function customerSearchRows(body: unknown): CustomerSearchResult[] {
  const rows = (body as { data?: unknown } | null)?.data;
  return Array.isArray(rows) ? (rows as CustomerSearchResult[]) : [];
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
        if (!cancelled) setResults(customerSearchRows(res.data));
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
