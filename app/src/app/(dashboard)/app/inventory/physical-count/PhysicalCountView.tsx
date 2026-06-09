"use client";

// /app/src/app/(dashboard)/app/inventory/physical-count/PhysicalCountView.tsx
//
// Physical Count scanner body: location picker, scan-to-count input, recent-scan
// history with infinite scroll, and an "unidentified item" photo modal. App
// Router port of the legacy pages/inventory/physical-count.tsx body. The legacy
// ScannerLayout chrome is replaced by a local focused header band (CountHeader)
// since the dashboard nav comes from the (dashboard) layout. Reads the shared
// /api/inventory/* + /api/products REST endpoints.

import { useState, useRef, useEffect, useCallback, type KeyboardEvent } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { Trash2, Camera } from "lucide-react";
import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormTextArea from "@/components/form/FormTextArea";
import { getErrorMessage } from "@/lib/toastError";

interface FoundProduct {
  id: number;
  name: string;
  productNumber: string;
}

interface ScanHistoryItem {
  id: number;
  quantity: number;
  countedAt: string;
  product: {
    name: string;
    productNumber: string;
  };
}

export function PhysicalCountView() {
  const [location, setLocation] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inventoryLocations, setInventoryLocations] = useState<string[]>([]);

  const [scanHistory, setScanHistory] = useState<ScanHistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const identifierInputRef = useRef<HTMLInputElement>(null);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [unidentifiedFile, setUnidentifiedFile] = useState<File | null>(null);
  const [unidentifiedNotes, setUnidentifiedNotes] = useState("");

  const loadLocations = useCallback(async () => {
    try {
      const res = await axios.get<string[]>("/api/inventory/locations");
      setInventoryLocations(res.data);
      if (res.data.length > 0) setLocation(res.data[0]);
    } catch {
      toast.error("Could not load inventory locations.");
    }
  }, []);

  useEffect(() => {
    loadLocations();
  }, [loadLocations]);

  // Reset and load the first page of scan history for the current location.
  // Keyed on location only so it re-runs cleanly when the picker changes.
  const reloadHistory = useCallback(async () => {
    if (!location) return;
    setLoadingHistory(true);
    try {
      const { data } = await axios.get("/api/inventory/scan-history", {
        params: { location },
      });
      setScanHistory(data.counts);
      setNextCursor(data.nextCursor);
    } catch {
      toast.error("Failed to load scan history.");
    } finally {
      setLoadingHistory(false);
    }
  }, [location]);

  // Append the next page of history when the user scrolls to the bottom.
  const loadMoreHistory = useCallback(async () => {
    if (loadingHistory || nextCursor === null) return;
    setLoadingHistory(true);
    try {
      const { data } = await axios.get("/api/inventory/scan-history", {
        params: { location, cursor: nextCursor },
      });
      setScanHistory((prev) => [...prev, ...data.counts]);
      setNextCursor(data.nextCursor);
    } catch {
      toast.error("Failed to load scan history.");
    } finally {
      setLoadingHistory(false);
    }
  }, [loadingHistory, nextCursor, location]);

  useEffect(() => {
    reloadHistory();
  }, [reloadHistory]);

  // Force focus on the input after the component mounts (100ms so the UI is ready).
  useEffect(() => {
    const focusTimeout = setTimeout(() => {
      identifierInputRef.current?.focus();
    }, 100);
    return () => clearTimeout(focusTimeout);
  }, []);

  const handleScan = async () => {
    if (!identifier.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      const productRes = await axios.get<FoundProduct>(
        `/api/products/find-by-identifier?identifier=${encodeURIComponent(identifier.trim())}`,
      );
      const foundProduct = productRes.data;

      const countRes = await axios.post("/api/inventory/physical-count", {
        productId: foundProduct.id,
        stockLocation: location,
        quantity: Number(quantity),
      });

      const newScan: ScanHistoryItem = {
        ...countRes.data,
        product: { name: foundProduct.name, productNumber: foundProduct.productNumber },
      };
      setScanHistory((prev) => [newScan, ...prev]);

      toast.success(`+${quantity} -> ${foundProduct.name}`);
      setIdentifier("");
      setQuantity(1);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, `Error: Product not found for "${identifier}".`));
      setIdentifier("");
    } finally {
      setIsSubmitting(false);
      identifierInputRef.current?.focus();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      handleScan();
    }
  };

  const handleScroll = () => {
    const container = scrollContainerRef.current;
    if (container && container.scrollTop + container.clientHeight >= container.scrollHeight - 100) {
      loadMoreHistory();
    }
  };

  const handleDeleteScan = async (scanId: number) => {
    if (!globalThis.confirm("Are you sure you want to delete this scan?")) return;
    try {
      await axios.delete(`/api/inventory/physical-count/${scanId}`);
      setScanHistory((prev) => prev.filter((scan) => scan.id !== scanId));
      toast.success("Scan deleted.");
    } catch {
      toast.error("Failed to delete scan.");
    }
  };

  const handleUnidentifiedSubmit = async () => {
    if (!unidentifiedFile) {
      toast.error("Please select an image to upload.");
      return;
    }
    setIsSubmitting(true);
    const formData = new FormData();
    formData.append("image", unidentifiedFile);
    formData.append("location", location);
    formData.append("notes", unidentifiedNotes);

    try {
      await axios.post("/api/inventory/unidentified-scan", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      toast.success("Unidentified item logged successfully.");
      setIsModalOpen(false);
      setUnidentifiedFile(null);
      setUnidentifiedNotes("");
    } catch {
      toast.error("Failed to upload image.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-8rem)] -mt-4">
      <CountHeader />
      <div className="p-2 bg-sh-linen border-b border-sh-gray space-y-2">
        <div>
          <label htmlFor="count-location" className="block text-sh-black mb-1 text-sm">
            Counting Location
          </label>
          <select
            id="count-location"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="border rounded p-2 w-full"
            disabled={inventoryLocations.length === 0}
          >
            {inventoryLocations.length === 0 && <option>No locations loaded...</option>}
            {inventoryLocations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <div className="col-span-1">
            <label htmlFor="count-qty" className="block text-sh-black mb-1 text-sm">
              Qty
            </label>
            <input
              id="count-qty"
              type="number"
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value))}
              className="border rounded p-2 w-full text-center text-lg font-bold"
            />
          </div>
          <div className="col-span-3">
            <label htmlFor="count-identifier" className="block text-sh-black mb-1 text-sm">
              Scan Barcode or Part #
            </label>
            <input
              id="count-identifier"
              ref={identifierInputRef}
              type="text"
              inputMode="none"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              onKeyDown={handleKeyDown}
              className="border rounded p-2 w-full text-lg"
              placeholder="Ready for scan..."
              autoFocus
            />
          </div>
        </div>
        <Button
          variant="outline"
          fullWidth
          onClick={() => setIsModalOpen(true)}
          disabled={!location}
        >
          <Camera className="w-4 h-4 mr-2" />
          Can&apos;t Scan Item? (Take Photo)
        </Button>
      </div>

      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-grow overflow-y-auto p-2"
      >
        <h2 className="font-bold text-sh-blue mb-2">Your Recent Scans in {location}</h2>
        {scanHistory.map((scan) => (
          <div
            key={scan.id}
            className="border-b border-gray-200 py-2 flex justify-between items-center"
          >
            <div>
              <p className="font-bold">{scan.product.name}</p>
              <p className="text-sm text-sh-gray">
                {scan.product.productNumber} -
                <span className="font-semibold text-sh-black"> Qty: {scan.quantity} </span>(
                {format(new Date(scan.countedAt), "p")})
              </p>
            </div>
            <Button variant="secondary" onClick={() => handleDeleteScan(scan.id)}>
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
        {loadingHistory && <p className="text-center text-sh-gray py-4">Loading more...</p>}
        {nextCursor === null && scanHistory.length > 0 && (
          <p className="text-center text-sh-gray py-4">End of list.</p>
        )}
      </div>

      {isModalOpen && (
        <UnidentifiedModal
          notes={unidentifiedNotes}
          onNotesChange={setUnidentifiedNotes}
          onFileChange={setUnidentifiedFile}
          onClose={() => setIsModalOpen(false)}
          onSave={handleUnidentifiedSubmit}
          saving={isSubmitting}
        />
      )}
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
        {firstName ? `${firstName}'s Count` : "Inventory Count"}
      </h1>
      {session && (
        <Button variant="secondary" onClick={handleSignOut}>
          Sign Out
        </Button>
      )}
    </header>
  );
}

interface UnidentifiedModalProps {
  notes: string;
  onNotesChange: (value: string) => void;
  onFileChange: (file: File | null) => void;
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
}

function UnidentifiedModal({
  notes,
  onNotesChange,
  onFileChange,
  onClose,
  onSave,
  saving,
}: Readonly<UnidentifiedModalProps>) {
  return (
    <Modal title="Log Unidentified Item" onClose={onClose} onSave={onSave} saving={saving}>
      <p className="text-sm text-sh-gray mb-4">
        If an item doesn&apos;t have a barcode, take a clear photo of it and add any helpful notes.
      </p>
      <div>
        <label htmlFor="unidentified-photo" className="block text-sh-blue font-serif mb-1">
          Photo
        </label>
        <input
          id="unidentified-photo"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={(e) => onFileChange(e.target.files ? e.target.files[0] : null)}
          className="block w-full text-sm text-sh-black
                    file:mr-4 file:py-2 file:px-4
                    file:rounded-full file:border-0
                    file:text-sm file:font-semibold
                    file:bg-sh-blue file:text-white
                    hover:file:bg-sh-black"
        />
      </div>
      <FormTextArea
        label="Notes (optional)"
        name="notes"
        value={notes}
        onChange={onNotesChange}
        placeholder="e.g., 'Found in back corner', 'Possible floor model'"
      />
    </Modal>
  );
}
