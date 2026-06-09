// /app/src/hooks/useStickyDraftDefaults.ts
//
// Per-user-per-browser sticky defaults for the buyer-drafts wizard. The buyer
// typically enters a batch of items from one vendor / department / category
// at a time; pre-filling these lets them blast through the batch instead of
// re-picking the same dropdowns 30 times.
//
// localStorage scope: per browser. Different users on the same machine share
// (their session is gated upstream by withAuth role checks). Reset by
// calling clear() — useful from a "reset defaults" button if the buyer
// switches workflows mid-session.

import { useCallback, useEffect, useState } from "react";

export interface DraftDefaults {
  vendorId: number | null;
  vendorName: string; // free-text fallback for new-vendor case
  departmentId: number | null;
  categoryId: number | null;
  typeId: number | null;
  stockLocationId: number | null;
  stockProgram: boolean;
  stockFamily: string;
  expectedShipMonth: string;
  draftPoId: number | null;
}

const EMPTY_DEFAULTS: DraftDefaults = {
  vendorId: null,
  vendorName: "",
  departmentId: null,
  categoryId: null,
  typeId: null,
  stockLocationId: null,
  stockProgram: false,
  stockFamily: "",
  expectedShipMonth: "",
  draftPoId: null,
};

const STORAGE_KEY = "holt.buyerDrafts.lastDefaults.v1";

// SSR-safe read. localStorage is undefined during getServerSideProps + initial
// React hydration, so fall back to EMPTY_DEFAULTS until useEffect runs.
function readFromStorage(): DraftDefaults {
  if (globalThis.localStorage === undefined) return EMPTY_DEFAULTS;
  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<DraftDefaults>;
    return { ...EMPTY_DEFAULTS, ...parsed };
  } catch {
    return EMPTY_DEFAULTS;
  }
}

export function useStickyDraftDefaults() {
  const [defaults, setDefaults] = useState<DraftDefaults>(EMPTY_DEFAULTS);

  // Hydrate from localStorage after mount (avoids SSR mismatch).
  useEffect(() => {
    setDefaults(readFromStorage());
  }, []);

  const update = useCallback((patch: Partial<DraftDefaults>) => {
    setDefaults((prev) => {
      const next = { ...prev, ...patch };
      if (globalThis.localStorage !== undefined) {
        try {
          globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          /* quota exceeded etc. — non-fatal */
        }
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setDefaults(EMPTY_DEFAULTS);
    if (globalThis.localStorage !== undefined) {
      try {
        globalThis.localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* non-fatal */
      }
    }
  }, []);

  return { defaults, update, clear };
}
