"use client";

// /app/src/app/(dashboard)/app/inventory/hub/InventoryHubView.tsx
//
// Physical Inventory Hub body (step cards + consignment/snapshot/report links +
// at-a-glance totals + destructive "danger zone" controls). App Router port of
// the legacy pages/inventory/hub.tsx body, minus MainLayout chrome (supplied by
// the (dashboard) layout). Reads the shared /api/inventory/* REST endpoints.

import { useState, useEffect, useCallback } from "react";
import { toast } from "react-toastify";
import axios from "axios";
import Link from "next/link";
import OnHandSummary from "@/components/dashboard/OnHandSummary";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

function LinkCard({
  href,
  title,
  description,
}: Readonly<{ href: string; title: string; description: string }>) {
  return (
    <Link
      href={href}
      className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-5 hover:shadow-lg transition block group"
    >
      <h2 className="text-lg font-semibold text-sh-black mb-1 group-hover:text-sh-blue transition">
        {title}
      </h2>
      <p className="text-sh-gray text-sm">{description}</p>
    </Link>
  );
}

// A LinkCard-alike for a secondary/migration path rather than the normal
// flow -- amber border so it visually reads as "not the button you usually
// want" next to the Core Actions cards.
function SecondaryLinkCard({
  href,
  title,
  description,
}: Readonly<{ href: string; title: string; description: string }>) {
  return (
    <Link
      href={href}
      className="bg-amber-50 rounded-lg border border-amber-400/40 shadow-sm p-5 hover:shadow-md transition block group"
    >
      <h2 className="text-lg font-semibold text-amber-900 mb-1 group-hover:text-amber-700 transition">
        {title}
      </h2>
      <p className="text-amber-800/80 text-sm">{description}</p>
    </Link>
  );
}

// Step 1 of a physical count: freeze today's expected on-hand baseline from
// holt's own InventoryPosition data (POST /api/inventory/snapshot/generate).
// Styled like LinkCard so it sits naturally among the Core Actions cards, but
// it's a button -- generating a snapshot is an action with a result to
// report, not a navigation.
function GenerateSnapshotCard() {
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    const confirmed = globalThis.confirm(
      "Generate today's inventory snapshot from current on-hand data? " +
        "This replaces any snapshot already generated today.",
    );
    if (!confirmed) return;

    setGenerating(true);
    try {
      const { data } = await axios.post("/api/inventory/snapshot/generate");
      toast.success(
        `Snapshot generated: ${data.products.toLocaleString()} products, ` +
          `${data.units.toLocaleString()} units, ${data.stores.toLocaleString()} store locations.`,
      );
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to generate inventory snapshot."));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <button
      type="button"
      onClick={handleGenerate}
      disabled={generating}
      className="bg-white rounded-lg border border-sh-gray/20 shadow-md p-5 hover:shadow-lg transition block group text-left w-full disabled:opacity-60 disabled:cursor-wait"
    >
      <h2 className="text-lg font-semibold text-sh-black mb-1 group-hover:text-sh-blue transition">
        {generating ? "Generating..." : "Step 1: Generate Snapshot"}
      </h2>
      <p className="text-sh-gray text-sm">
        Freeze today&apos;s expected on-hand baseline from current inventory data.
      </p>
    </button>
  );
}

interface DangerZoneProps {
  locations: string[];
  selectedLocation: string;
  onSelectLocation: (location: string) => void;
  onClearLocation: () => void;
  onClearAll: () => void;
}

function HubDangerZone({
  locations,
  selectedLocation,
  onSelectLocation,
  onClearLocation,
  onClearAll,
}: Readonly<DangerZoneProps>) {
  return (
    <div className="bg-white rounded-lg border border-red-500/20 shadow-md p-5">
      <h2 className="text-xl font-semibold text-red-600 mb-2">Danger Zone</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
        <div>
          <p className="text-sh-gray text-sm mb-2">
            Clear data for a single location. This is for correcting mistakes and cannot be undone.
          </p>
          <div className="flex items-end gap-2">
            <div className="flex-grow">
              <label htmlFor="clear-location" className="sr-only">
                Location to clear
              </label>
              <select
                id="clear-location"
                value={selectedLocation}
                onChange={(e) => onSelectLocation(e.target.value)}
                className="border border-sh-gray rounded-lg px-3 py-2 w-full text-sh-black font-serif"
                disabled={locations.length === 0}
              >
                {locations.length === 0 && <option>No locations found</option>}
                {locations.map((loc) => (
                  <option key={loc} value={loc}>
                    {loc}
                  </option>
                ))}
              </select>
            </div>
            <Button variant="secondary" onClick={onClearLocation} disabled={!selectedLocation}>
              Clear Location
            </Button>
          </div>
        </div>
        <div className="border-t md:border-t-0 md:border-l border-gray-200/80 pl-6 pt-6 md:pt-0">
          <p className="text-sh-gray text-sm mb-2">
            Clear ALL inventory data to prepare for a new, company-wide count. This is irreversible.
          </p>
          <Button variant="secondary" onClick={onClearAll}>
            Reset All Inventory Data
          </Button>
        </div>
      </div>
    </div>
  );
}

export function InventoryHubView() {
  const [locations, setLocations] = useState<string[]>([]);
  const [selectedLocationToClear, setSelectedLocationToClear] = useState("");

  const loadLocations = useCallback(async () => {
    try {
      const res = await axios.get<string[]>("/api/inventory/locations");
      setLocations(res.data);
      if (res.data.length > 0) {
        setSelectedLocationToClear(res.data[0]);
      }
    } catch {
      toast.error("Could not load inventory locations for the clear function.");
    }
  }, []);

  useEffect(() => {
    loadLocations();
  }, [loadLocations]);

  const handleClearLocation = async () => {
    if (!selectedLocationToClear) {
      toast.warn("Please select a location to clear.");
      return;
    }
    const confirmed = globalThis.confirm(
      `ARE YOU SURE? This will delete ALL physical scans for the "${selectedLocationToClear}" location. This cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      toast.info(`Clearing scans for ${selectedLocationToClear}...`);
      await axios.post("/api/inventory/clear-location", { location: selectedLocationToClear });
      toast.success(`Successfully cleared all scans for ${selectedLocationToClear}.`);
    } catch (err: unknown) {
      toast.error(
        getErrorMessage(
          err,
          `An error occurred while clearing scans for ${selectedLocationToClear}.`,
        ),
      );
    }
  };

  const handleClearAllData = async () => {
    const confirmation = prompt(
      'This is a highly destructive action that will delete ALL physical counts, reconciliations, and unidentified photos. This is not reversible. To confirm, type "DELETE ALL" in the box below.',
    );
    if (confirmation !== "DELETE ALL") {
      toast.warn("Clear all operation cancelled.");
      return;
    }
    try {
      toast.info("Clearing all inventory data...");
      const response = await axios.post("/api/inventory/clear-all-data");
      toast.success(response.data.message || "All inventory data cleared successfully.");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "An error occurred while clearing all data."));
    }
  };

  return (
    <div className="py-2 space-y-6 font-serif">
      <div>
        <h1 className="text-2xl font-semibold text-sh-blue mb-2">Physical Inventory Hub</h1>
        <p className="text-sh-gray">Start here for all physical inventory tasks.</p>
      </div>

      {/* Core Actions */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <GenerateSnapshotCard />
        <LinkCard
          href="/app/inventory/physical-count"
          title="Step 2: Start Counting"
          description="Go to the scanning page to begin or continue a count."
        />
        <LinkCard
          href="/app/inventory/reconcile-photos"
          title="Step 3: Reconcile Photos"
          description="Identify and match photos of unscannable items."
        />
      </div>

      {/* Consignment */}
      <div>
        <h2 className="text-xl font-semibold text-sh-blue mb-3">Consignment</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <LinkCard
            href="/app/inventory/consignment"
            title="Consignment Rugs"
            description="View and manage consignment rug inventory, approvals, and sales."
          />
          <LinkCard
            href="/app/inventory/consignment/count"
            title="Count Rugs"
            description="Scan rug barcodes to verify which consignment items are on hand."
          />
          <LinkCard
            href="/app/inventory/consignment/return"
            title="Return to Vendor"
            description="Scan rugs to mark as returned to vendor."
          />
        </div>
      </div>

      {/* Inventory Freeze */}
      <div>
        <h2 className="text-xl font-semibold text-sh-blue mb-3">Snapshots</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <LinkCard
            href="/app/inventory/freeze"
            title="Inventory Freeze"
            description="Create and compare point-in-time inventory snapshots."
          />
        </div>
      </div>

      {/* Reconciliation Reports */}
      <div>
        <h2 className="text-xl font-semibold text-sh-blue mb-3">Reconciliation Reports</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <LinkCard
            href="/app/inventory/variance-apparel"
            title="Apparel Variance Report"
            description="Reconcile Accessories, Mens Apparel, and Womens Apparel."
          />
          <LinkCard
            href="/app/inventory/variance-report"
            title="General Variance Report"
            description="Reconcile all other departments and locations."
          />
        </div>
      </div>

      {/* Migration / Cutover Tools -- NOT the normal Step 1. Kept only to
          compare a POS export against holt's own snapshot while validating
          the cutover; see InventorySnapshot's schema comment. */}
      <div>
        <h2 className="text-xl font-semibold text-amber-800 mb-1">Migration &amp; Cutover Tools</h2>
        <p className="text-sh-gray text-sm mb-3">
          Not part of the normal count flow. Use only to parallel-run a POS export against
          holt&apos;s own snapshot (Step 1 above) while validating a cutover.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <SecondaryLinkCard
            href="/app/admin/import/inventory-snapshot"
            title="Import POS Snapshot"
            description="Upload a POS on-hand export for comparison. Resolves POS ids/locations to holt's own before writing."
          />
        </div>
      </div>

      {/* At-a-Glance Totals */}
      <OnHandSummary />

      {/* Danger Zone Actions */}
      <HubDangerZone
        locations={locations}
        selectedLocation={selectedLocationToClear}
        onSelectLocation={setSelectedLocationToClear}
        onClearLocation={handleClearLocation}
        onClearAll={handleClearAllData}
      />
    </div>
  );
}
