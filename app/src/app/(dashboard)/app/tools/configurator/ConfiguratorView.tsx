"use client";

// /app/src/app/(dashboard)/app/tools/configurator/ConfiguratorView.tsx
//
// Designer-facing product configurator showing retail prices only. Reuses the
// same PriceConfigurator component with retailOnly mode, hiding wholesale costs
// and margins. Reads the shared /api/vendors + /api/pricing/products REST
// endpoints. Any signed-in user; the page gated server-side. Chrome from the
// (dashboard) layout.

import { useState, useEffect, useMemo, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import PriceConfigurator from "@/components/pricing/PriceConfigurator";
import WoodPriceConfigurator from "@/components/pricing/WoodPriceConfigurator";
import SEConfigurator from "@/components/pricing/SEConfigurator";
import FramePlusCushionConfigurator from "@/components/pricing/FramePlusCushionConfigurator";
import { ProductWithPricing, WoodProductWithPricing } from "@/lib/pricing/priceCalculator";
import { Loader2, AlertCircle } from "lucide-react";

interface VendorOption {
  id: number;
  name: string;
}

export function ConfiguratorView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const returnTo = searchParams?.get("returnTo") ?? undefined;
  const isQuoteMode = returnTo === "quote";

  // Saves configured item to sessionStorage and navigates back to the quote builder
  const handleAddToQuote = useCallback(
    (item: {
      productId: number;
      productNumber: string;
      name: string;
      description: string;
      price: number;
      cost: number;
      vendor: string;
    }) => {
      sessionStorage.setItem("configuredItem", JSON.stringify(item));
      router.push("/app/sales/quotes/new");
    },
    [router],
  );

  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<number | null>(null);
  const [products, setProducts] = useState<ProductWithPricing[]>([]);
  const [woodProducts, setWoodProducts] = useState<WoodProductWithPricing[]>([]);
  const [fcData, setFcData] = useState<{
    frames: any[];
    cushions: any[];
    covers: any[];
    costMultiplier: number | null;
  } | null>(null);
  const [pricingModel, setPricingModel] = useState<string>("");
  const [dimensions, setDimensions] = useState<any[]>([]);
  const [vendorName, setVendorName] = useState("");
  const [defaultMarkup, setDefaultMarkup] = useState(2.5);
  const [defaultDiscount, setDefaultDiscount] = useState(0);
  const [mapEnforced, setMapEnforced] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seMode, setSEMode] = useState(false);

  const standardProducts = useMemo(
    () => products.filter((p) => !p.productNumber.startsWith("SE-")),
    [products],
  );
  const seProducts = useMemo(
    () => products.filter((p) => p.productNumber.startsWith("SE-")),
    [products],
  );
  const hasSE = seProducts.length > 0;

  useEffect(() => {
    setSEMode(false);
  }, [selectedVendorId]);

  useEffect(() => {
    fetch("/api/vendors?all=true&withPricing=true")
      .then((r) => r.json())
      .then((data) => {
        const list: VendorOption[] = (data.vendors || data || []).map((v: any) => ({
          id: v.id,
          name: v.name,
        }));
        setVendors(list);

        const wh = list.find((v) => v.name.toLowerCase().includes("wesley hall"));
        if (wh) {
          setSelectedVendorId(wh.id);
        } else if (list.length === 1) {
          setSelectedVendorId(list[0].id);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedVendorId) {
      setProducts([]);
      return;
    }

    setLoading(true);
    setError(null);

    fetch(`/api/pricing/products?vendorId=${selectedVendorId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        const model = data.vendor?.pricingModel || "GRADE_BASED";
        setPricingModel(model);
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
          setWoodProducts(data.products || []);
          setProducts([]);
          setFcData(null);
        } else {
          setProducts(data.products || []);
          setWoodProducts([]);
          setFcData(null);
        }
      })
      .catch((err) => {
        setError(err.message || "Failed to load products");
        setProducts([]);
        setWoodProducts([]);
      })
      .finally(() => setLoading(false));
  }, [selectedVendorId]);

  return (
    <div className="space-y-6 py-2 font-serif">
      {isQuoteMode && (
        <div className="flex items-center justify-between rounded-lg border border-sh-gold/30 bg-sh-gold/10 px-4 py-2 text-sm text-sh-black">
          <span>Adding to quote -- configure an item and click Add to Quote</span>
          <button
            onClick={() => router.push("/app/sales/quotes/new")}
            className="font-semibold text-sh-blue transition hover:text-sh-black"
          >
            Back to Quote
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-sh-blue">Product Configurator</h1>

        <div className="flex items-center gap-3">
          <label htmlFor="vendor" className="text-sm text-sh-gray">
            Vendor:
          </label>
          <select
            id="vendor"
            value={selectedVendorId ?? ""}
            onChange={(e) => setSelectedVendorId(e.target.value ? Number(e.target.value) : null)}
            className="min-w-[200px] rounded-lg border border-sh-gray bg-white px-3 py-2 text-sm text-sh-black"
          >
            <option value="">Select a vendor...</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Standard / Signature Elements toggle */}
      {hasSE && !loading && (
        <div className="flex w-fit items-center gap-1 rounded-lg bg-sh-stripe p-1">
          <button
            onClick={() => setSEMode(false)}
            className={`rounded-md px-4 py-1.5 font-sans text-sm transition ${
              !seMode ? "bg-white text-sh-blue shadow-sm" : "text-sh-gray hover:text-sh-black"
            }`}
          >
            Standard
          </button>
          <button
            onClick={() => setSEMode(true)}
            className={`rounded-md px-4 py-1.5 font-sans text-sm transition ${
              seMode ? "bg-white text-sh-blue shadow-sm" : "text-sh-gray hover:text-sh-black"
            }`}
          >
            Signature Elements
          </button>
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="mr-3 h-6 w-6 animate-spin text-sh-blue" />
          <span className="text-sh-gray">Loading products...</span>
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4">
          <AlertCircle className="h-5 w-5 flex-shrink-0 text-red-500" />
          <div>
            <p className="text-sm font-semibold text-red-700">Failed to load pricing data</p>
            <p className="mt-1 text-xs text-red-600">{error}</p>
          </div>
        </div>
      )}

      {!selectedVendorId && !loading && (
        <div className="py-16 text-center">
          <p className="text-sh-gray">Select a vendor above to browse products.</p>
        </div>
      )}

      {selectedVendorId &&
        !loading &&
        !error &&
        products.length === 0 &&
        woodProducts.length === 0 &&
        (!fcData || fcData.frames.length === 0) && (
          <div className="py-16 text-center">
            <p className="text-sh-gray">No products with pricing data found for this vendor.</p>
          </div>
        )}

      {/* Standard configurator */}
      {!loading && !error && products.length > 0 && !seMode && standardProducts.length > 0 && (
        <div className="flex min-h-0 flex-col" style={{ height: "calc(100vh - 220px)" }}>
          <PriceConfigurator
            products={standardProducts}
            vendorId={selectedVendorId!}
            vendorName={vendorName}
            defaultMarkup={defaultMarkup}
            defaultDiscount={defaultDiscount}
            mapEnforced={mapEnforced}
            retailOnly
            onAddToQuote={isQuoteMode ? handleAddToQuote : undefined}
          />
        </div>
      )}

      {/* Signature Elements configurator */}
      {!loading && !error && seMode && seProducts.length > 0 && (
        <div className="flex min-h-0 flex-col" style={{ height: "calc(100vh - 220px)" }}>
          <SEConfigurator
            products={seProducts}
            vendorId={selectedVendorId!}
            vendorName={vendorName}
            defaultMarkup={defaultMarkup}
            defaultDiscount={defaultDiscount}
            mapEnforced={mapEnforced}
            retailOnly
            onAddToQuote={isQuoteMode ? handleAddToQuote : undefined}
          />
        </div>
      )}

      {!loading && !error && woodProducts.length > 0 && (
        <div className="flex min-h-0 flex-col" style={{ height: "calc(100vh - 220px)" }}>
          <WoodPriceConfigurator
            products={woodProducts}
            dimensions={dimensions}
            vendorName={vendorName}
            defaultMarkup={defaultMarkup}
            defaultDiscount={defaultDiscount}
            mapEnforced={mapEnforced}
            retailOnly
            onAddToQuote={isQuoteMode ? handleAddToQuote : undefined}
          />
        </div>
      )}

      {/* Frame+Cushion configurator (outdoor vendors) */}
      {!loading && !error && fcData && fcData.frames.length > 0 && (
        <div className="flex min-h-0 flex-col" style={{ height: "calc(100vh - 220px)" }}>
          <FramePlusCushionConfigurator
            frames={fcData.frames}
            cushions={fcData.cushions}
            covers={fcData.covers}
            vendorId={selectedVendorId!}
            vendorName={vendorName}
            retailOnly
            onAddToQuote={isQuoteMode ? handleAddToQuote : undefined}
          />
        </div>
      )}
    </div>
  );
}
