"use client";

// /app/src/app/(dashboard)/app/inventory/reconcile-photos/ReconcilePhotosView.tsx
//
// Reconcile Unidentified Photos body (location filter + photo grid + match-to-
// product modal). App Router port of the legacy
// pages/inventory/reconcile-photos.tsx body, minus MainLayout chrome (supplied
// by the (dashboard) layout). Reads the shared /api/inventory/* + /api/products
// REST endpoints.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import { useProductSearch } from "@/hooks/useProductSearch";
import { getErrorMessage } from "@/lib/toastError";

interface UnidentifiedScan {
  id: number;
  imageUrl: string;
  location: string;
  notes: string | null;
  countedAt: string;
  countedBy: { name: string | null } | null;
}

interface ScanCardProps {
  scan: UnidentifiedScan;
  onIgnore: (scanId: number) => void;
  onReconcile: (scan: UnidentifiedScan) => void;
}

function ScanCard({ scan, onIgnore, onReconcile }: Readonly<ScanCardProps>) {
  return (
    <div className="border rounded-lg shadow-sm bg-white overflow-hidden flex flex-col">
      <img src={scan.imageUrl} alt="Unidentified Item" className="w-full h-48 object-cover" />
      <div className="p-3 flex-grow flex flex-col">
        <p className="text-xs text-sh-gray">
          {format(new Date(scan.countedAt), "Pp")} by {scan.countedBy?.name || "Unknown"}
        </p>
        <p className="text-sm my-2 flex-grow">{scan.notes || <em>No notes provided.</em>}</p>
        <div className="flex gap-2 mt-auto">
          <Button size="sm" variant="secondary" onClick={() => onIgnore(scan.id)}>
            Ignore
          </Button>
          <Button size="sm" variant="primary" onClick={() => onReconcile(scan)}>
            Reconcile
          </Button>
        </div>
      </div>
    </div>
  );
}

interface ScanGridProps {
  loading: boolean;
  scans: UnidentifiedScan[];
  selectedLocation: string;
  onIgnore: (scanId: number) => void;
  onReconcile: (scan: UnidentifiedScan) => void;
}

function ScanGrid({
  loading,
  scans,
  selectedLocation,
  onIgnore,
  onReconcile,
}: Readonly<ScanGridProps>) {
  if (loading) {
    return <p>Loading scans...</p>;
  }
  if (scans.length === 0) {
    return (
      <p className="text-center text-sh-gray py-8">
        No pending photos to reconcile for {selectedLocation}.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {scans.map((scan) => (
        <ScanCard key={scan.id} scan={scan} onIgnore={onIgnore} onReconcile={onReconcile} />
      ))}
    </div>
  );
}

export function ReconcilePhotosView() {
  const [locations, setLocations] = useState<string[]>([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [scans, setScans] = useState<UnidentifiedScan[]>([]);
  const [loading, setLoading] = useState(false);

  const [selectedScan, setSelectedScan] = useState<UnidentifiedScan | null>(null);
  const {
    query: searchTerm,
    setQuery: setSearchTerm,
    results: searchResults,
  } = useProductSearch({ minLength: 3 });
  const [isSaving, setIsSaving] = useState(false);

  const loadLocations = useCallback(async () => {
    try {
      const res = await axios.get<string[]>("/api/inventory/locations");
      setLocations(res.data);
      if (res.data.length > 0) setSelectedLocation(res.data[0]);
    } catch {
      toast.error("Could not load inventory locations.");
    }
  }, []);

  useEffect(() => {
    loadLocations();
  }, [loadLocations]);

  const fetchScans = useCallback(async () => {
    if (!selectedLocation) return;
    setLoading(true);
    try {
      const res = await axios.get(`/api/inventory/unidentified-scans?location=${selectedLocation}`);
      setScans(res.data);
    } catch {
      toast.error(`Failed to load scans for ${selectedLocation}.`);
    } finally {
      setLoading(false);
    }
  }, [selectedLocation]);

  useEffect(() => {
    fetchScans();
  }, [fetchScans]);

  const handleReconcile = async (productId: number) => {
    if (!selectedScan) return;
    setIsSaving(true);
    try {
      await axios.post("/api/inventory/reconcile-unidentified", {
        scanId: selectedScan.id,
        productId,
        action: "RECONCILE",
      });
      toast.success("Item reconciled successfully!");
      setScans((prev) => prev.filter((s) => s.id !== selectedScan.id));
      setSelectedScan(null);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to reconcile item."));
    } finally {
      setIsSaving(false);
    }
  };

  const handleIgnore = async (scanId: number) => {
    const confirmed = globalThis.confirm(
      "Are you sure you want to ignore this item? It will be hidden from this list.",
    );
    if (!confirmed) return;
    try {
      await axios.post("/api/inventory/reconcile-unidentified", { scanId, action: "IGNORE" });
      toast.warn("Item ignored.");
      setScans((prev) => prev.filter((s) => s.id !== scanId));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to ignore item."));
    }
  };

  return (
    <div className="max-w-6xl mx-auto mt-8 font-serif">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-semibold text-sh-blue">Reconcile Photos</h1>
        <div>
          <label htmlFor="reconcile-location" className="sr-only">
            Location
          </label>
          <select
            id="reconcile-location"
            value={selectedLocation}
            onChange={(e) => setSelectedLocation(e.target.value)}
            className="border rounded p-2"
            disabled={locations.length === 0}
          >
            {locations.map((loc) => (
              <option key={loc} value={loc}>
                {loc}
              </option>
            ))}
          </select>
        </div>
      </div>

      <ScanGrid
        loading={loading}
        scans={scans}
        selectedLocation={selectedLocation}
        onIgnore={handleIgnore}
        onReconcile={setSelectedScan}
      />

      {selectedScan && (
        <Modal
          title="Reconcile Item"
          onClose={() => setSelectedScan(null)}
          onSave={() => {}}
          saving={isSaving}
        >
          <div className="flex gap-4">
            <img
              src={selectedScan.imageUrl}
              alt="Item"
              className="w-[150px] h-[150px] rounded-lg object-cover"
            />
            <div>
              <p>
                <strong>Notes:</strong> {selectedScan.notes || "N/A"}
              </p>
              <p>
                <strong>Location:</strong> {selectedScan.location}
              </p>
            </div>
          </div>
          <FormInput
            label="Search for Product by Name or SKU"
            name="search"
            value={searchTerm}
            onChange={setSearchTerm}
          />
          <div className="max-h-60 overflow-y-auto border rounded p-2">
            {searchResults.map((p) => (
              <div key={p.id} className="p-2 hover:bg-sh-linen flex justify-between items-center">
                <span>
                  {p.name} ({p.productNumber})
                </span>
                <Button size="sm" onClick={() => handleReconcile(p.id)}>
                  Select
                </Button>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
