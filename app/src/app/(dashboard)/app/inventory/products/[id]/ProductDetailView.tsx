"use client";

// /app/src/app/(dashboard)/app/inventory/products/[id]/ProductDetailView.tsx
//
// Product detail body. App Router port of the legacy inventory/products/[id]
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Reads
// the shared /api/products/:id REST endpoint, which stays REST. Edit modal +
// "Back to Products" link preserved.

import { useEffect, useState, useCallback } from "react";
import axios from "axios";
import Link from "next/link";
import { format } from "date-fns";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import ProductEditModal from "@/components/modals/ProductEditModal";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";

interface ProductDetails {
  id: number;
  externalId?: number;
  productNumber: string;
  name: string;
  description?: string;
  season?: string;
  imageUrl?: string;
  isActive: boolean;
  isDiscontinued: boolean;
  baseCost: number | null;
  baseRetail: number | null;
  mapPrice: number | null;
  length?: number;
  width?: number;
  depth?: number;
  height?: number;
  weight?: number;
  cubicFeet?: number;
  seatHeight?: number;
  armHeight?: number;
  seatDepth?: number;
  freightClass?: string;
  shipsVia?: string;
  cartonQty?: number;
  vendor?: { id: number; name: string };
  department?: { id: number; name: string };
  category?: { id: number; name: string };
  type?: { id: number; name: string };
  collection?: { id: number; name: string };
  vendorStyle?: { id: number; styleNumber: string; name: string };
  upcs: { id: number; upc: string }[];
  created: string;
  updated: string;
}

function StatusBadge({ active }: { active: boolean }) {
  const className = active ? "bg-green-100 text-green-800" : "bg-sh-gray/20 text-sh-gray";
  return (
    <span className={`text-xs px-2 py-0.5 rounded ${className}`}>
      {active ? "Active" : "Inactive"}
    </span>
  );
}

function DimensionRow({
  label,
  value,
  suffix,
}: {
  label: string;
  value: number | null | undefined;
  suffix: string;
}) {
  if (value == null) return null;
  return (
    <p>
      <strong>{label}:</strong> {value}
      {suffix}
    </p>
  );
}

export function ProductDetailView({ id }: { id: string }) {
  const fmt = useMoneyFormatter();
  const [product, setProduct] = useState<ProductDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [showEditModal, setShowEditModal] = useState(false);

  const fetchProduct = useCallback(async () => {
    setLoading(true);
    try {
      const res = await axios.get(`/api/products/${encodeURIComponent(id)}`);
      setProduct(res.data);
    } catch {
      toast.error("Failed to load product.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchProduct();
  }, [fetchProduct]);

  if (loading) {
    return <p>Loading product details...</p>;
  }

  if (!product) {
    return <p>Product not found.</p>;
  }

  const margin =
    product.baseRetail != null && product.baseCost != null && product.baseRetail > 0
      ? ((product.baseRetail - product.baseCost) / product.baseRetail) * 100
      : null;

  const hasDimensions =
    product.length || product.width || product.depth || product.height || product.weight;

  return (
    <div className="max-w-4xl mx-auto mt-8 font-serif">
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-sh-blue">{product.name}</h1>
          <p className="text-sm text-sh-gray mt-1">
            {product.productNumber}
            {product.vendor && <span className="ml-3">{product.vendor.name}</span>}
          </p>
          <div className="flex gap-2 mt-2">
            <StatusBadge active={product.isActive} />
            {product.isDiscontinued && (
              <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-800">
                Discontinued
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setShowEditModal(true)}>
            Edit
          </Button>
          <Link href="/app/inventory/products">
            <Button variant="secondary">Back to Products</Button>
          </Link>
        </div>
      </div>

      {/* Description */}
      {product.description && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <p className="text-sm text-sh-gray">{product.description}</p>
        </div>
      )}

      {/* Pricing */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Pricing</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
          <div>
            <p className="text-sh-gray text-xs uppercase tracking-wide">Cost</p>
            <p className="text-lg font-semibold">
              {product.baseCost != null ? fmt(product.baseCost) : "N/A"}
            </p>
          </div>
          <div>
            <p className="text-sh-gray text-xs uppercase tracking-wide">Retail</p>
            <p className="text-lg font-semibold">
              {product.baseRetail != null ? fmt(product.baseRetail) : "N/A"}
            </p>
          </div>
          <div>
            <p className="text-sh-gray text-xs uppercase tracking-wide">MAP</p>
            <p className="text-lg font-semibold">
              {product.mapPrice != null ? fmt(product.mapPrice) : "N/A"}
            </p>
          </div>
          <div>
            <p className="text-sh-gray text-xs uppercase tracking-wide">Margin</p>
            <p className="text-lg font-semibold">
              {margin != null ? `${margin.toFixed(1)}%` : "N/A"}
            </p>
          </div>
        </div>
      </div>

      {/* Classification */}
      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Classification</h2>
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p>
              <strong>Department:</strong> {product.department?.name || "N/A"}
            </p>
            <p>
              <strong>Category:</strong> {product.category?.name || "N/A"}
            </p>
            <p>
              <strong>Type:</strong> {product.type?.name || "N/A"}
            </p>
          </div>
          <div>
            <p>
              <strong>Collection:</strong> {product.collection?.name || "N/A"}
            </p>
            <p>
              <strong>Season:</strong> {product.season || "N/A"}
            </p>
            {product.vendorStyle && (
              <p>
                <strong>Style:</strong> {product.vendorStyle.styleNumber}
                {product.vendorStyle.name && ` - ${product.vendorStyle.name}`}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Physical Attributes */}
      {hasDimensions && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">Physical Attributes</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <DimensionRow label="Length" value={product.length} suffix={'"'} />
            <DimensionRow label="Width" value={product.width} suffix={'"'} />
            <DimensionRow label="Depth" value={product.depth} suffix={'"'} />
            <DimensionRow label="Height" value={product.height} suffix={'"'} />
            <DimensionRow label="Weight" value={product.weight} suffix=" lbs" />
            <DimensionRow label="Cubic Feet" value={product.cubicFeet} suffix="" />
            <DimensionRow label="Seat Height" value={product.seatHeight} suffix={'"'} />
            <DimensionRow label="Seat Depth" value={product.seatDepth} suffix={'"'} />
          </div>
        </div>
      )}

      {/* Barcodes */}
      {product.upcs.length > 0 && (
        <div className="bg-white p-6 rounded-lg shadow-md mb-6">
          <h2 className="text-xl font-semibold mb-3">Barcodes</h2>
          <div className="flex flex-wrap gap-2">
            {product.upcs.map((u) => (
              <span key={u.id} className="px-3 py-1 bg-sh-linen rounded text-sm font-mono">
                {u.upc}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Audit */}
      <div className="text-xs text-sh-gray mb-8">
        {product.externalId && <span>the POS ID: {product.externalId} | </span>}
        Created: {product.created ? format(new Date(product.created), "PPP") : "N/A"}
        {product.updated && <> | Updated: {format(new Date(product.updated), "PPP")}</>}
      </div>

      {showEditModal && (
        <ProductEditModal
          product={product}
          onClose={() => setShowEditModal(false)}
          onSave={() => {
            setShowEditModal(false);
            fetchProduct();
          }}
        />
      )}
    </div>
  );
}
