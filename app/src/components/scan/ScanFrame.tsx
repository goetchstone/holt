"use client";

// /app/src/components/scan/ScanFrame.tsx
//
// The frame every handheld page shares (ledger plan phase 15): a title, the
// store the scanner is working in (the staff member's active store), the scan
// field DataWedge types into, and the last message in large type, green or
// red, readable at arm's length. Pages put their own steps below.

import Link from "next/link";
import type { ReactNode } from "react";
import { useActiveStore } from "@/hooks/useActiveStore";
import { useWedgeScan } from "@/hooks/useWedgeScan";

export interface ScanMessage {
  tone: "ok" | "error" | "info";
  text: string;
}

const TONE: Record<ScanMessage["tone"], string> = {
  ok: "bg-green-50 text-green-900 border-green-300",
  error: "bg-red-50 text-red-900 border-red-300",
  info: "bg-brand-linen text-brand-black border-brand-gray/20",
};

export function ScanFrame({
  title,
  prompt,
  onScan,
  message,
  scanEnabled = true,
  children,
}: {
  title: string;
  /** What to scan next, shown in the field. */
  prompt: string;
  onScan: (code: string, storeLocationId: number | null) => void;
  message: ScanMessage | null;
  scanEnabled?: boolean;
  children?: ReactNode;
}) {
  const { activeStore, allStores, setActiveStore } = useActiveStore();
  const { inputProps } = useWedgeScan((code) => onScan(code, activeStore?.id ?? null), {
    enabled: scanEnabled,
  });

  return (
    <div className="mx-auto max-w-lg space-y-3 font-serif">
      <div className="flex items-center justify-between">
        <Link href="/app/scan" className="text-sm text-brand-blue underline">
          ‹ Scan menu
        </Link>
        <select
          aria-label="Store"
          value={activeStore?.id ?? ""}
          onChange={(e) => void setActiveStore(Number(e.target.value))}
          className="border border-brand-gray/30 rounded px-2 py-1 text-sm"
        >
          {!activeStore && <option value="">Choose a store</option>}
          {allStores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      <h1 className="text-xl font-semibold text-brand-blue">{title}</h1>
      <input
        {...inputProps}
        aria-label={prompt}
        placeholder={prompt}
        disabled={!scanEnabled}
        className="w-full border-2 border-brand-blue rounded px-3 py-3 text-lg"
      />
      {message && (
        <p role="status" className={`border rounded px-3 py-2 text-lg ${TONE[message.tone]}`}>
          {message.text}
        </p>
      )}
      {children}
    </div>
  );
}
