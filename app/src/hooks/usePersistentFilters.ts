// /app/src/hooks/usePersistentFilters.ts

import { useState, useEffect } from "react";

export function usePersistentFilters<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    if (globalThis.window === undefined) return initial;
    try {
      const stored = localStorage.getItem(key);
      return stored ? JSON.parse(stored) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore storage errors silently
    }
  }, [key, value]);

  return [value, setValue] as const;
}
