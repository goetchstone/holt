// /app/src/hooks/usePagination.ts
//
// Shared pagination state hook. Replaces the duplicated page/total/limit
// useState triplet found in service/index, interactions/index,
// warehouse/positions, and other list pages. Provides computed totalPages
// and navigation helpers so pages only need to wire up the return values.

import { useState, useCallback, useMemo } from "react";

interface UsePaginationReturn {
  page: number;
  setPage: (p: number) => void;
  total: number;
  setTotal: (t: number) => void;
  limit: number;
  totalPages: number;
  nextPage: () => void;
  prevPage: () => void;
  resetPage: () => void;
  canGoNext: boolean;
  canGoPrev: boolean;
}

export function usePagination(initialLimit = 20): UsePaginationReturn {
  const [page, setPageRaw] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = initialLimit;

  const totalPages = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total, limit]);

  const setPage = useCallback(
    (p: number) => {
      setPageRaw(Math.max(1, Math.min(p, totalPages)));
    },
    [totalPages],
  );

  const nextPage = useCallback(() => {
    setPageRaw((p) => Math.min(p + 1, totalPages));
  }, [totalPages]);

  const prevPage = useCallback(() => {
    setPageRaw((p) => Math.max(p - 1, 1));
  }, []);

  const resetPage = useCallback(() => {
    setPageRaw(1);
  }, []);

  const canGoNext = page < totalPages;
  const canGoPrev = page > 1;

  return {
    page,
    setPage,
    total,
    setTotal,
    limit,
    totalPages,
    nextPage,
    prevPage,
    resetPage,
    canGoNext,
    canGoPrev,
  };
}
