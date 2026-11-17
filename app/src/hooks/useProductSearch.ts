// /app/src/hooks/useProductSearch.ts
//
// Shared hook for product search-as-you-type. Replaces the duplicated
// debounce + fetch pattern in quotes/new, pos, warehouse/transfers/new,
// and inventory/reconcile-photos. All had their own 300ms setTimeout
// and manual cleanup logic.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { useDebounce } from "./useDebounce";
import { searchAsYouTypeStatus, type SearchAsYouTypeStatus } from "@/lib/searchAsYouTypeStatus";

export interface ProductSearchResult {
  id: number;
  productNumber: string;
  name: string;
  /** What the register charges today: a sale price while the product's sale is on. */
  baseRetail?: number | null;
  /** The price off sale, and whether a scheduled sale applies today (lib/pricing/salePrice.ts). */
  regularRetail?: number | null;
  onSale?: boolean;
  saleEndsOn?: string | null;
  baseCost?: number | null;
  vendorName?: string;
  departmentName?: string;
  categoryName?: string;
  /** Whether a customer's trade tier may discount it (GAP-06 part C). */
  tradeEligible?: boolean;
  /** Whether the store lets a tier come off a sale price (lib/pricing/screenPricing.ts). */
  tradeDiscountOnSaleItems?: boolean;
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
  /** True only while a request is out; false during the debounce window. */
  isSearching: boolean;
  /**
   * Whether `results` answer what is typed now. Use this, not isSearching,
   * to decide when an empty list means "no match" (lib/searchAsYouTypeStatus).
   */
  status: SearchAsYouTypeStatus;
  clear: () => void;
}

export function useProductSearch(options?: UseProductSearchOptions): UseProductSearchReturn {
  const minLength = options?.minLength ?? 2;
  const debounceMs = options?.debounceMs ?? 300;
  const limit = options?.limit ?? 15;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProductSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  // The query `results` answer, so a caller can tell held results from
  // results for what is typed now.
  const [answeredQuery, setAnsweredQuery] = useState<string | null>(null);

  const debouncedQuery = useDebounce(query, debounceMs);

  useEffect(() => {
    if (debouncedQuery.length < minLength) {
      setResults([]);
      setAnsweredQuery(debouncedQuery);
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
          setAnsweredQuery(debouncedQuery);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResults([]);
          setAnsweredQuery(debouncedQuery);
        }
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

  const status = searchAsYouTypeStatus(query, answeredQuery, minLength);

  return { query, setQuery, results, isSearching, status, clear };
}
