// /app/src/hooks/useDebounce.ts
//
// Generic debounce hook. Returns a debounced version of the input value
// that only updates after the specified delay. Use for search inputs
// to avoid firing API calls on every keystroke.

import { useState, useEffect } from "react";

export function useDebounce<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
