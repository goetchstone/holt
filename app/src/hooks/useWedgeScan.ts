"use client";

// /app/src/hooks/useWedgeScan.ts
//
// A handheld scanner in keyboard-wedge mode (DataWedge on a Zebra) types the
// barcode into whatever has focus and ends it with Enter or Tab. One hook for
// every scan page: it keeps a hidden-keyboard input focused, hands each
// complete scan to `onScan`, clears the input, and ignores the same code sent
// twice within a breath (some wedges repeat on a long trigger press).

import { useCallback, useEffect, useRef } from "react";
import { cleanScan } from "@/lib/scan/scanCodes";

const REPEAT_WINDOW_MS = 400;

export function useWedgeScan(onScan: (code: string) => void, opts: { enabled?: boolean } = {}) {
  const ref = useRef<HTMLInputElement>(null);
  const last = useRef<{ code: string; at: number } | null>(null);
  const enabled = opts.enabled ?? true;

  const focus = useCallback(() => {
    if (enabled) ref.current?.focus();
  }, [enabled]);

  useEffect(() => {
    const t = setTimeout(focus, 100);
    return () => clearTimeout(t);
  }, [focus]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter" && e.key !== "Tab") return;
      e.preventDefault();
      const code = cleanScan(e.currentTarget.value);
      e.currentTarget.value = "";
      if (!code) return;
      const now = Date.now();
      if (last.current && last.current.code === code && now - last.current.at < REPEAT_WINDOW_MS) {
        return;
      }
      last.current = { code, at: now };
      onScan(code);
      focus();
    },
    [onScan, focus],
  );

  return {
    focus,
    inputProps: {
      ref,
      onKeyDown,
      // Back to the scan field when focus falls on nothing; not when it moved
      // to another field (a quantity) on purpose.
      onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
        if (!e.relatedTarget) setTimeout(focus, 200);
      },
      inputMode: "none" as const,
      autoComplete: "off",
      autoCapitalize: "off",
      spellCheck: false,
    },
  };
}
