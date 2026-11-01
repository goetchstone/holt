// /app/src/components/sales/useQuoteHoldPolicy.ts
//
// The store's quote-hold policy for a screen that offers holds (GAP-16): today
// and the last day a hold may run to. Null until it loads, or when it could not
// be read -- a screen then offers no hold rather than a day the server refuses.

import { useEffect, useState } from "react";
import axios from "axios";
import type { QuoteHoldPolicy } from "@/lib/sales/quoteHoldsShared";

export function useQuoteHoldPolicy(): QuoteHoldPolicy | null {
  const [policy, setPolicy] = useState<QuoteHoldPolicy | null>(null);
  useEffect(() => {
    let live = true;
    axios
      .get<QuoteHoldPolicy>("/api/sales/quote-hold-policy")
      .then((res) => {
        if (live) setPolicy(res.data);
      })
      .catch(() => {
        if (live) setPolicy(null);
      });
    return () => {
      live = false;
    };
  }, []);
  return policy;
}
