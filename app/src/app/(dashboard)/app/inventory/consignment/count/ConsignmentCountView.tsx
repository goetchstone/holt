"use client";

// /app/src/app/(dashboard)/app/inventory/consignment/count/ConsignmentCountView.tsx
//
// Consignment Count scanner body: scan-to-tally input, running scanned/expected/
// missing counts, scanned + unknown lists, and a reconciliation report modal.
// App Router port of the legacy inventory/consignment/count body. The legacy
// ScannerLayout chrome is replaced by a local focused header band (CountHeader)
// since the dashboard nav comes from the (dashboard) layout. Reads the shared
// /api/consignment/* REST endpoints; money uses the tenant formatter.

import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface ScannedItem {
  barcode: string;
  quality: string | null;
  size: string | null;
  cost: number;
  retailPrice: number | null;
  status: string;
  vendor: { name: string } | null;
}

interface UnknownScan {
  barcode: string;
}

const STATUS_LABEL: Record<string, string> = {
  ON_FLOOR: "On Floor",
  ON_APPROVAL: "On Approval",
  SOLD: "Sold",
  RETURNED_VENDOR: "Returned",
  MISSING: "Missing",
  PAID: "Paid",
};

const STATUS_BADGE: Record<string, string> = {
  ON_FLOOR: "bg-green-100 text-green-800",
  ON_APPROVAL: "bg-amber-100 text-amber-800",
  SOLD: "bg-blue-100 text-blue-800",
  RETURNED_VENDOR: "bg-gray-100 text-gray-600",
  MISSING: "bg-red-100 text-red-800",
  PAID: "bg-sh-gold/20 text-sh-gold",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] || status;
}

function badgeClass(status: string): string {
  return STATUS_BADGE[status] || "bg-gray-100 text-gray-600";
}

export function ConsignmentCountView() {
  const [barcode, setBarcode] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scannedItems, setScannedItems] = useState<ScannedItem[]>([]);
  const [unknownScans, setUnknownScans] = useState<UnknownScan[]>([]);
  const [expectedOnHand, setExpectedOnHand] = useState<number | null>(null);
  const [showReport, setShowReport] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadSummary = useCallback(async () => {
    try {
      const res = await axios.get<{ expectedOnHand: number }>("/api/consignment/count-summary");
      setExpectedOnHand(res.data.expectedOnHand);
    } catch {
      toast.error("Could not load expected count.");
    }
  }, []);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    const timeout = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(timeout);
  }, []);

  const handleScan = async () => {
    const trimmed = barcode.trim();
    if (!trimmed || isSubmitting) return;

    // Prevent duplicate scans in this session
    if (
      scannedItems.some((i) => i.barcode === trimmed) ||
      unknownScans.some((u) => u.barcode === trimmed)
    ) {
      toast.warn(`Already scanned: ${trimmed}`);
      setBarcode("");
      inputRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    try {
      const { data } = await axios.post<ScannedItem>("/api/consignment/scan", {
        barcode: trimmed,
      });
      setScannedItems((prev) => [data, ...prev]);
      toast.success(`Found: ${data.quality || data.barcode}`);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        setUnknownScans((prev) => [{ barcode: trimmed }, ...prev]);
        toast.warn(`Unknown barcode: ${trimmed}`);
      } else {
        toast.error("Scan lookup failed.");
      }
    } finally {
      setBarcode("");
      setIsSubmitting(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleScan();
    }
  };

  const totalScanned = scannedItems.length;
  const missingCount = expectedOnHand !== null ? Math.max(0, expectedOnHand - totalScanned) : null;

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] -mt-4">
      <CountHeader />

      {/* Scanner input */}
      <div className="p-3 bg-sh-linen border-b border-sh-gray/30 space-y-3">
        <div>
          <label htmlFor="count-barcode" className="block text-sh-black mb-1 text-sm">
            Scan Rug Barcode
          </label>
          <input
            id="count-barcode"
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

        {/* Running tally */}
        <div className="grid grid-cols-3 gap-2 text-center text-sm">
          <div className="bg-white rounded-lg border border-sh-gray/20 p-2">
            <div className="text-sh-gray">Scanned</div>
            <div className="text-xl font-bold text-sh-blue">{totalScanned}</div>
          </div>
          <div className="bg-white rounded-lg border border-sh-gray/20 p-2">
            <div className="text-sh-gray">Expected</div>
            <div className="text-xl font-bold text-sh-black">
              {expectedOnHand !== null ? expectedOnHand : "-"}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-sh-gray/20 p-2">
            <div className="text-sh-gray">Missing</div>
            <div className="text-xl font-bold text-red-600">
              {missingCount !== null ? missingCount : "-"}
            </div>
          </div>
        </div>

        {unknownScans.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-800">
            {unknownScans.length} unknown barcode{unknownScans.length !== 1 ? "s" : ""}
          </div>
        )}

        <Button
          fullWidth
          onClick={() => setShowReport(true)}
          disabled={totalScanned === 0}
          className="min-h-[44px]"
        >
          Complete Count
        </Button>
      </div>

      {/* Scan list */}
      <div className="flex-grow overflow-y-auto p-2">
        <h2 className="font-bold text-sh-blue mb-2 font-serif">Scanned Items</h2>
        {scannedItems.length === 0 && (
          <p className="text-sh-gray text-sm py-4 text-center">
            No items scanned yet. Start scanning rug barcodes.
          </p>
        )}
        {scannedItems.map((item) => (
          <ScannedRow key={item.barcode} item={item} />
        ))}

        {unknownScans.length > 0 && (
          <>
            <h2 className="font-bold text-amber-700 mt-4 mb-2 font-serif">Unknown Barcodes</h2>
            {unknownScans.map((u) => (
              <div key={u.barcode} className="border-b border-amber-200 py-2">
                <p className="font-bold text-amber-800">{u.barcode}</p>
              </div>
            ))}
          </>
        )}
      </div>

      {showReport && (
        <ReconciliationReport
          expectedOnHand={expectedOnHand}
          totalScanned={totalScanned}
          missingCount={missingCount}
          unknownScans={unknownScans}
          onClose={() => setShowReport(false)}
        />
      )}
    </div>
  );
}

function ScannedRow({ item }: Readonly<{ item: ScannedItem }>) {
  const fmt = useMoneyFormatter();
  return (
    <div className="border-b border-sh-gray/10 py-2 flex justify-between items-start">
      <div>
        <p className="font-bold text-sh-black font-serif">{item.barcode}</p>
        <p className="text-sm text-sh-gray">
          {item.quality || "Unknown quality"}
          {item.size ? ` / ${item.size}` : ""}
          {item.cost ? ` / ${fmt(item.cost)}` : ""}
        </p>
      </div>
      <span
        className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${badgeClass(
          item.status,
        )}`}
      >
        {statusLabel(item.status)}
      </span>
    </div>
  );
}

interface ReconciliationReportProps {
  expectedOnHand: number | null;
  totalScanned: number;
  missingCount: number | null;
  unknownScans: UnknownScan[];
  onClose: () => void;
}

function ReconciliationReport({
  expectedOnHand,
  totalScanned,
  missingCount,
  unknownScans,
  onClose,
}: Readonly<ReconciliationReportProps>) {
  return (
    <div className="fixed inset-0 bg-sh-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-lg max-w-lg w-full max-h-[80vh] overflow-y-auto">
        <div className="p-5 border-b border-sh-gray/20">
          <h2 className="text-xl font-semibold text-sh-blue font-serif">Count Reconciliation</h2>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-sh-linen rounded-lg p-3">
              <div className="text-sh-gray">Expected on Hand</div>
              <div className="text-2xl font-bold text-sh-black">{expectedOnHand ?? "-"}</div>
            </div>
            <div className="bg-sh-linen rounded-lg p-3">
              <div className="text-sh-gray">Scanned</div>
              <div className="text-2xl font-bold text-sh-blue">{totalScanned}</div>
            </div>
            <div className="bg-sh-linen rounded-lg p-3">
              <div className="text-sh-gray">Missing</div>
              <div className="text-2xl font-bold text-red-600">{missingCount ?? "-"}</div>
            </div>
            <div className="bg-sh-linen rounded-lg p-3">
              <div className="text-sh-gray">Unknown</div>
              <div className="text-2xl font-bold text-amber-700">{unknownScans.length}</div>
            </div>
          </div>

          {unknownScans.length > 0 && (
            <div>
              <h3 className="font-semibold text-sh-black mb-1 font-serif">Unknown Barcodes</h3>
              <ul className="text-sm text-sh-gray space-y-1">
                {unknownScans.map((u) => (
                  <li key={u.barcode} className="font-mono">
                    {u.barcode}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="p-5 border-t border-sh-gray/20 flex justify-end">
          <Button onClick={onClose} className="min-h-[44px]">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

function CountHeader() {
  const { data: session } = useSession();
  const router = useRouter();
  const firstName = session?.user?.name ? session.user.name.split(" ")[0] : null;

  const handleSignOut = async () => {
    await signOut({ redirect: false });
    router.push("/auth/login");
  };

  return (
    <header className="w-full bg-sh-blue text-white px-4 py-2 flex items-center justify-between shadow-md">
      <h1 className="font-serif text-lg font-bold">
        {firstName ? `${firstName}'s Count` : "Consignment Count"}
      </h1>
      {session && (
        <Button variant="secondary" onClick={handleSignOut}>
          Sign Out
        </Button>
      )}
    </header>
  );
}
