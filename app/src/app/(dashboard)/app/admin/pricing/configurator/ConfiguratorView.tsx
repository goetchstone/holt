"use client";

// /app/src/app/(dashboard)/app/admin/pricing/configurator/ConfiguratorView.tsx
//
// Interactive price configurator body. App Router port of the legacy
// admin/pricing/configurator body (minus MainLayout chrome, which the
// (dashboard) layout supplies). Picks a vendor, loads its products, and renders
// the pricing-model-appropriate configurator (standard / Signature Elements /
// wood / frame+cushion). Vendor pricing settings (markup, discount, MAP) save
// through PATCH /api/vendors/:id. All fetches stay against the REST endpoints.

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import PriceConfigurator from "@/components/pricing/PriceConfigurator";
import WoodPriceConfigurator from "@/components/pricing/WoodPriceConfigurator";
import SEConfigurator from "@/components/pricing/SEConfigurator";
import FramePlusCushionConfigurator from "@/components/pricing/FramePlusCushionConfigurator";
import { ProductWithPricing, WoodProductWithPricing } from "@/lib/pricing/priceCalculator";
import { getErrorMessage } from "@/lib/toastError";
import { toast } from "react-toastify";
import { Loader2, AlertCircle, Settings, Save, Check } from "lucide-react";

// ─── Types ─────────────────────────────────────────────────────────

interface VendorOption {
  id: number;
  name: string;
}

// The frame+cushion configurator owns the precise element shapes; the API
// returns them under these keys for FRAME_PLUS_CUSHION vendors. We pass them
// straight through, so a structural alias keeps this view free of `any`.
type FramePlusCushionProps = React.ComponentProps<typeof FramePlusCushionConfigurator>;
type DimensionInfo = React.ComponentProps<typeof WoodPriceConfigurator>["dimensions"][number];

interface FramePlusCushionData {
  frames: FramePlusCushionProps["frames"];
  cushions: FramePlusCushionProps["cushions"];
  covers: FramePlusCushionProps["covers"];
  costMultiplier: number | null;
}

interface PricingProductsResponse {
  vendor?: {
    name?: string;
    pricingModel?: string;
    defaultMarkup?: number;
    defaultDiscount?: number;
    mapEnforced?: boolean;
    costMultiplier?: number | null;
  };
  dimensions?: DimensionInfo[];
  products?: ProductWithPricing[] | WoodProductWithPricing[];
  frames?: FramePlusCushionProps["frames"];
  cushions?: FramePlusCushionProps["cushions"];
  covers?: FramePlusCushionProps["covers"];
}

const CONFIGURATOR_HEIGHT = { height: "calc(100vh - 220px)" } as const;

// ─── Sub-components ─────────────────────────────────────────────────

function VendorSettingsPanel({
  vendorName,
  editMarkup,
  editDiscount,
  editMapEnforced,
  saving,
  saved,
  onMarkupChange,
  onDiscountChange,
  onMapEnforcedChange,
  onSave,
}: Readonly<{
  vendorName: string;
  editMarkup: string;
  editDiscount: string;
  editMapEnforced: boolean;
  saving: boolean;
  saved: boolean;
  onMarkupChange: (value: string) => void;
  onDiscountChange: (value: string) => void;
  onMapEnforcedChange: (value: boolean) => void;
  onSave: () => void;
}>) {
  let saveLabel = "Save Settings";
  if (saved) saveLabel = "Saved!";
  else if (saving) saveLabel = "Saving…";

  return (
    <div className="bg-white rounded-lg border border-sh-gray/20 shadow-sm p-5 max-w-2xl">
      <h3 className="text-sm font-semibold text-sh-blue mb-4 flex items-center gap-2">
        <Settings className="w-4 h-4" />
        Pricing Settings — {vendorName}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div>
          <label htmlFor="cfg-markup" className="block text-xs text-sh-gray mb-1">
            Default Markup (multiplier)
          </label>
          <input
            id="cfg-markup"
            type="number"
            step="0.1"
            min="1"
            max="10"
            value={editMarkup}
            onChange={(e) => onMarkupChange(e.target.value)}
            className="w-full border border-sh-gray rounded-lg px-3 py-2 text-sm tabular-nums"
            placeholder="2.5"
          />
          <span className="text-xs text-sh-gray mt-1 block">e.g. 2.5 = 2.5× wholesale</span>
        </div>

        <div>
          <label htmlFor="cfg-discount" className="block text-xs text-sh-gray mb-1">
            Default Discount (%)
          </label>
          <div className="relative">
            <input
              id="cfg-discount"
              type="number"
              step="1"
              min="0"
              max="99"
              value={editDiscount}
              onChange={(e) => onDiscountChange(e.target.value)}
              className="w-full border border-sh-gray rounded-lg px-3 py-2 text-sm tabular-nums pr-8"
              placeholder="0"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sh-gray text-sm">
              %
            </span>
          </div>
          <span className="text-xs text-sh-gray mt-1 block">Off suggested retail</span>
        </div>

        <div>
          <label htmlFor="cfg-map" className="block text-xs text-sh-gray mb-1">
            MAP Enforced
          </label>
          <label
            htmlFor="cfg-map"
            className="flex items-center gap-2 mt-2 cursor-pointer text-sm text-sh-black"
          >
            <input
              id="cfg-map"
              type="checkbox"
              checked={editMapEnforced}
              onChange={(e) => onMapEnforcedChange(e.target.checked)}
              className="w-5 h-5 accent-sh-blue"
            />
            Enforce minimum advertised price
          </label>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 bg-sh-blue text-white rounded-lg text-sm hover:bg-sh-blue/90 disabled:opacity-50 transition"
        >
          <SaveButtonIcon saving={saving} saved={saved} />
          {saveLabel}
        </button>
        <span className="text-xs text-sh-gray">
          Settings are saved to this vendor and applied automatically.
        </span>
      </div>
    </div>
  );
}

function SaveButtonIcon({ saving, saved }: Readonly<{ saving: boolean; saved: boolean }>) {
  if (saving) return <Loader2 className="w-4 h-4 animate-spin" />;
  if (saved) return <Check className="w-4 h-4" />;
  return <Save className="w-4 h-4" />;
}

function EmptyState({
  message,
  children,
}: Readonly<{ message: string; children?: React.ReactNode }>) {
  return (
    <div className="text-center py-16">
      <p className="text-sh-gray">{message}</p>
      {children}
    </div>
  );
}

// ─── Main view ─────────────────────────────────────────────────────

export function ConfiguratorView() {
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<number | null>(null);
  const [products, setProducts] = useState<ProductWithPricing[]>([]);
  const [woodProducts, setWoodProducts] = useState<WoodProductWithPricing[]>([]);
  const [fcData, setFcData] = useState<FramePlusCushionData | null>(null);
  const [dimensions, setDimensions] = useState<DimensionInfo[]>([]);
  const [vendorName, setVendorName] = useState("");
  const [defaultMarkup, setDefaultMarkup] = useState(2.5);
  const [defaultDiscount, setDefaultDiscount] = useState(0);
  const [mapEnforced, setMapEnforced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);

  const [seMode, setSEMode] = useState(false);

  // Editable settings state
  const [editMarkup, setEditMarkup] = useState("2.5");
  const [editDiscount, setEditDiscount] = useState("0");
  const [editMapEnforced, setEditMapEnforced] = useState(false);

  // Split products into standard and Signature Elements
  const standardProducts = useMemo(
    () => products.filter((p) => !p.productNumber.startsWith("SE-")),
    [products],
  );
  const seProducts = useMemo(
    () => products.filter((p) => p.productNumber.startsWith("SE-")),
    [products],
  );
  const hasSE = seProducts.length > 0;

  // Reset SE mode when vendor changes
  useEffect(() => {
    setSEMode(false);
  }, [selectedVendorId]);

  // Sync editable settings when vendor data loads
  useEffect(() => {
    setEditMarkup(String(defaultMarkup));
    setEditDiscount(String(Math.round(defaultDiscount * 100)));
    setEditMapEnforced(mapEnforced);
  }, [defaultMarkup, defaultDiscount, mapEnforced]);

  const saveVendorSettings = useCallback(async () => {
    if (!selectedVendorId) return;
    setSavingSettings(true);
    setSettingsSaved(false);
    try {
      const markup = Number.parseFloat(editMarkup) || 2.5;
      const discount = (Number.parseFloat(editDiscount) || 0) / 100;
      const resp = await fetch(`/api/vendors/${selectedVendorId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultMarkup: markup,
          defaultDiscount: discount,
          mapEnforced: editMapEnforced,
        }),
      });
      if (!resp.ok) throw new Error("Save failed");
      setDefaultMarkup(markup);
      setDefaultDiscount(discount);
      setMapEnforced(editMapEnforced);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to save vendor settings"));
    } finally {
      setSavingSettings(false);
    }
  }, [selectedVendorId, editMarkup, editDiscount, editMapEnforced]);

  // Load vendors on mount
  const loadVendors = useCallback(async () => {
    try {
      const res = await fetch("/api/vendors?all=true&withPricing=true");
      const data = await res.json();
      const list: VendorOption[] = (data.vendors || data || []).map(
        (v: { id: number; name: string }) => ({ id: v.id, name: v.name }),
      );
      setVendors(list);

      // Auto-select Wesley Hall if available
      const wh = list.find((v) => v.name.toLowerCase().includes("wesley hall"));
      if (wh) {
        setSelectedVendorId(wh.id);
      } else if (list.length === 1) {
        setSelectedVendorId(list[0].id);
      }
    } catch {
      // Vendor list is best-effort; the no-vendor state covers an empty list.
    }
  }, []);

  useEffect(() => {
    loadVendors();
  }, [loadVendors]);

  // Load products when vendor changes
  const loadProducts = useCallback(async () => {
    if (!selectedVendorId) {
      setProducts([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/pricing/products?vendorId=${selectedVendorId}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: PricingProductsResponse = await res.json();

      const model = data.vendor?.pricingModel || "GRADE_BASED";
      setVendorName(data.vendor?.name || "");
      setDefaultMarkup(data.vendor?.defaultMarkup || 2.5);
      setDefaultDiscount(data.vendor?.defaultDiscount || 0);
      setMapEnforced(data.vendor?.mapEnforced || false);
      setDimensions(data.dimensions || []);

      if (model === "FRAME_PLUS_CUSHION") {
        setFcData({
          frames: data.frames || [],
          cushions: data.cushions || [],
          covers: data.covers || [],
          costMultiplier: data.vendor?.costMultiplier ?? null,
        });
        setProducts([]);
        setWoodProducts([]);
      } else if (model === "SPECIES_MATRIX" || model === "MULTI_AXIS") {
        setWoodProducts((data.products as WoodProductWithPricing[]) || []);
        setProducts([]);
        setFcData(null);
      } else {
        setProducts((data.products as ProductWithPricing[]) || []);
        setWoodProducts([]);
        setFcData(null);
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to load products"));
      setProducts([]);
      setWoodProducts([]);
    } finally {
      setLoading(false);
    }
  }, [selectedVendorId]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  const noProducts =
    !!selectedVendorId &&
    !loading &&
    !error &&
    products.length === 0 &&
    woodProducts.length === 0 &&
    (!fcData || fcData.frames.length === 0);

  return (
    <div className="py-2 space-y-6 font-serif">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <h1 className="text-2xl text-sh-blue font-semibold">Price Configurator</h1>

        {/* Vendor selector + settings */}
        <div className="flex items-center gap-3">
          <label htmlFor="cfg-vendor" className="text-sm text-sh-gray">
            Vendor:
          </label>
          <select
            id="cfg-vendor"
            value={selectedVendorId ?? ""}
            onChange={(e) => setSelectedVendorId(e.target.value ? Number(e.target.value) : null)}
            className="border border-sh-gray rounded-lg px-3 py-2 text-sm bg-white text-sh-black min-w-[200px]"
          >
            <option value="">Select a vendor…</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          {selectedVendorId && (
            <button
              type="button"
              onClick={() => setShowSettings(!showSettings)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border transition ${
                showSettings
                  ? "bg-sh-blue text-white border-sh-blue"
                  : "bg-white text-sh-gray border-sh-gray hover:border-sh-blue hover:text-sh-blue"
              }`}
              title="Vendor pricing settings"
            >
              <Settings className="w-4 h-4" />
              Settings
            </button>
          )}
        </div>
      </div>

      {/* Standard / Signature Elements toggle */}
      {hasSE && !loading && (
        <div className="flex items-center gap-1 bg-sh-stripe rounded-lg p-1 w-fit">
          <button
            type="button"
            onClick={() => setSEMode(false)}
            className={`px-4 py-1.5 rounded-md text-sm font-sans transition ${
              !seMode ? "bg-white text-sh-blue shadow-sm" : "text-sh-gray hover:text-sh-black"
            }`}
          >
            Standard
          </button>
          <button
            type="button"
            onClick={() => setSEMode(true)}
            className={`px-4 py-1.5 rounded-md text-sm font-sans transition ${
              seMode ? "bg-white text-sh-blue shadow-sm" : "text-sh-gray hover:text-sh-black"
            }`}
          >
            Signature Elements
          </button>
        </div>
      )}

      {/* Vendor Pricing Settings */}
      {showSettings && selectedVendorId && (
        <VendorSettingsPanel
          vendorName={vendorName}
          editMarkup={editMarkup}
          editDiscount={editDiscount}
          editMapEnforced={editMapEnforced}
          saving={savingSettings}
          saved={settingsSaved}
          onMarkupChange={setEditMarkup}
          onDiscountChange={setEditDiscount}
          onMapEnforcedChange={setEditMapEnforced}
          onSave={saveVendorSettings}
        />
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-sh-blue mr-3" />
          <span className="text-sh-gray">Loading products…</span>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-200 rounded-lg p-4">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
          <div>
            <p className="text-sm text-red-700 font-semibold">Failed to load pricing data</p>
            <p className="text-xs text-red-600 mt-1">{error}</p>
          </div>
        </div>
      )}

      {/* No vendor selected */}
      {!selectedVendorId && !loading && (
        <EmptyState message="Select a vendor above to begin configuring prices." />
      )}

      {/* No products */}
      {noProducts && (
        <EmptyState message="No products with pricing data found for this vendor.">
          <p className="text-sm text-sh-gray mt-2">
            Import a price list first from{" "}
            <Link
              href="/app/admin/pricing/import"
              className="text-sh-blue underline underline-offset-2 hover:text-sh-blue/80"
            >
              the import page
            </Link>
            .
          </p>
        </EmptyState>
      )}

      {/* Standard configurator */}
      {!loading && !error && products.length > 0 && !seMode && standardProducts.length > 0 && (
        <div className="flex flex-col min-h-0" style={CONFIGURATOR_HEIGHT}>
          <PriceConfigurator
            products={standardProducts}
            vendorId={selectedVendorId!}
            vendorName={vendorName}
            defaultMarkup={defaultMarkup}
            defaultDiscount={defaultDiscount}
            mapEnforced={mapEnforced}
          />
        </div>
      )}

      {/* Signature Elements configurator */}
      {!loading && !error && seMode && seProducts.length > 0 && (
        <div className="flex flex-col min-h-0" style={CONFIGURATOR_HEIGHT}>
          <SEConfigurator
            products={seProducts}
            vendorId={selectedVendorId!}
            vendorName={vendorName}
            defaultMarkup={defaultMarkup}
            defaultDiscount={defaultDiscount}
            mapEnforced={mapEnforced}
          />
        </div>
      )}

      {/* Wood vendor configurator (species/axis pricing) */}
      {!loading && !error && woodProducts.length > 0 && (
        <div className="flex flex-col min-h-0" style={CONFIGURATOR_HEIGHT}>
          <WoodPriceConfigurator
            products={woodProducts}
            dimensions={dimensions}
            vendorName={vendorName}
            defaultMarkup={defaultMarkup}
            defaultDiscount={defaultDiscount}
            mapEnforced={mapEnforced}
          />
        </div>
      )}

      {/* Frame+Cushion configurator (outdoor vendors) */}
      {!loading && !error && fcData && fcData.frames.length > 0 && (
        <div className="flex flex-col min-h-0" style={CONFIGURATOR_HEIGHT}>
          <FramePlusCushionConfigurator
            frames={fcData.frames}
            cushions={fcData.cushions}
            covers={fcData.covers}
            vendorId={selectedVendorId!}
            vendorName={vendorName}
            costMultiplier={fcData.costMultiplier}
          />
        </div>
      )}
    </div>
  );
}
