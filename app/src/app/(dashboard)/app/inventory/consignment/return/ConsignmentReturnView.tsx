"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/return/ConsignmentReturnView.tsx
//
// Consignment Return-to-Vendor scanner body: scan-to-add input, running summary,
// and a process-returns action. App Router port of the legacy
// pages/inventory/consignment/return.tsx body. The legacy ScannerLayout chrome
// is replaced by a local focused header band (ReturnHeader) since the dashboard
// nav comes from the (dashboard) layout. Reads + mutates the shared
// /api/consignment/scan + /api/consignment/return-items REST endpoints; money
// uses the tenant formatter.

import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface ScannedReturnItem {
  barcode: string;
  quality: string | null;
  size: string | null;
  cost: number;
  retailPrice: number | null;
  status: string;
  vendor: { name: string } | null;
  confirmed: boolean;
}

function rugSuffix(count: number): string {
  return count !== 1 ? "s" : "";
}

export function ConsignmentReturnView() {
  const fmt = useMoneyFormatter();

  const [barcode, setBarcode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [returnItems, setReturnItems] = useState<ScannedReturnItem[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timeout = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timeout);
  }, []);

  const handleScan = useCallback(async () => {
    const trimmed = barcode.trim();
    if (!trimmed || isSubmitting) return;

    if (returnItems.some((i) => i.barcode === trimmed)) {
      toast.warn(`Already scanned: ${trimmed}`);
      setBarcode("");
      inputRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    try {
      const { data } = await axios.post<ScannedReturnItem>("/api/consignment/scan", {
        barcode: trimmed,
      });

      if (data.status !== "ON_FLOOR" && data.status !== "MISSING") {
        toast.error(`Cannot return: ${trimmed} has status "${data.status}"`);
        setBarcode("");
        setIsSubmitting(false);
        inputRef.current?.focus();
        return;
      }

      setReturnItems((prev) => [{ ...data, confirmed: false }, ...prev]);
      toast.success(`Found: ${data.quality || data.barcode}`);
    } catch (error: unknown) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        toast.error(`Barcode not found: ${trimmed}`);
      } else {
        toast.error(getErrorMessage(error, "Scan lookup failed."));
      }
    } finally {
      setBarcode("");
      setIsSubmitting(false);
      inputRef.current?.focus();
    }
  }, [barcode, isSubmitting, returnItems]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan();
    }
  };

  const handleRemoveItem = (barcodeToRemove: string) => {
    setReturnItems((prev) => prev.filter((i) => i.barcode !== barcodeToRemove));
  };

  const handleProcessReturns = async () => {
    if (returnItems.length === 0) return;

    const confirmed = globalThis.confirm(
      `Mark ${returnItems.length} rug${rugSuffix(returnItems.length)} as returned to vendor? This cannot be undone.`,
    );
    if (!confirmed) return;

    setIsProcessing(true);
    try {
      const barcodes = returnItems.map((i) => i.barcode);
      await axios.post("/api/consignment/return-items", { barcodes });
      toast.success(
        `${returnItems.length} rug${rugSuffix(returnItems.length)} returned to vendor.`,
      );
      setReturnItems([]);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error, "Failed to process returns."));
    } finally {
      setIsProcessing(false);
      inputRef.current?.focus();
    }
  };

  const totalCost = returnItems.reduce((sum, item) => sum + item.cost, 0);
  const processLabel = isProcessing
    ? "Processing..."
    : `Return ${returnItems.length} Rug${rugSuffix(returnItems.length)} to Vendor`;

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] -mt-4">
      <ReturnHeader />

      <div className="p-3 bg-sh-linen border-b border-sh-gray/30 space-y-3">
        <div>
          <label htmlFor="return-barcode" className="block text-sh-black mb-1 text-sm">
            Scan Rug Barcode for Return
          </label>
          <input
            id="return-barcode"
            ref={inputRef}
            type="text"
            inputMode="none"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={handleKeyDown}
            className="border border-sh-gray/40 rounded-lg p-3 w-full text-lg min-h-[44px]"
            placeholder="Ready for scan..."
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-2 text-center text-sm">
          <div className="bg-white rounded-lg border border-sh-gray/20 p-2">
            <div className="text-sh-gray">Rugs to Return</div>
            <div className="text-xl font-bold text-sh-blue">{returnItems.length}</div>
          </div>
          <div className="bg-white rounded-lg border border-sh-gray/20 p-2">
            <div className="text-sh-gray">Total Cost</div>
            <div className="text-xl font-bold text-sh-black">{fmt(totalCost)}</div>
          </div>
        </div>

        <Button
          fullWidth
          onClick={handleProcessReturns}
          disabled={returnItems.length === 0 || isProcessing}
          className="min-h-[44px]"
        >
          {processLabel}
        </Button>
      </div>

      <div className="flex-grow overflow-y-auto p-2">
        <h2 className="font-bold text-sh-blue mb-2 font-serif">Scanned for Return</h2>
        {returnItems.length === 0 && (
          <p className="text-sh-gray text-sm py-4 text-center">
            No items scanned. Scan rug barcodes to add them to the return list.
          </p>
        )}
        {returnItems.map((item) => (
          <div
            key={item.barcode}
            className="border-b border-sh-gray/10 py-2 flex justify-between items-start"
          >
            <div>
              <p className="font-bold text-sh-black font-serif">{item.barcode}</p>
              <p className="text-sm text-sh-gray">
                {item.quality || "Unknown quality"}
                {item.size ? ` / ${item.size}` : ""}
              </p>
              <p className="text-sm text-sh-gray">{fmt(item.cost)}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => handleRemoveItem(item.barcode)}
              className="min-h-[44px] min-w-[44px]"
            >
              Remove
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReturnHeader() {
  const { data: session } = useSession();
  const router = useRouter();

  const handleSignOut = async () => {
    await signOut({ redirect: false });
    router.push("/auth/login");
  };

  return (
    <header className="w-full bg-sh-blue text-white px-4 py-2 flex items-center justify-between shadow-md">
      <h1 className="font-serif text-lg font-bold">Return to Vendor</h1>
      {session && (
        <Button variant="secondary" onClick={handleSignOut}>
          Sign Out
        </Button>
      )}
    </header>
  );
}
