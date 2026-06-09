// /app/src/components/form/VendorFilter.tsx

"use client";

import { useEffect, useState } from "react";
import { useFetchOptions } from "@/hooks/useFetchOptions";

export default function VendorFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  // CORRECTED: Pass ?all=true to fetch all vendors
  const [vendors, loading, error] = useFetchOptions("/api/vendors?all=true");

  if (loading) {
    return (
      <div>
        <label className="font-serif text-sh-black mb-1 block">Vendor</label>
        <select disabled className="border p-2 w-full">
          <option value="">Loading Vendors...</option>
        </select>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <label className="font-serif text-sh-black mb-1 block">Vendor</label>
        <select disabled className="border p-2 w-full text-red-600">
          <option value="">Error loading Vendors</option>
        </select>
      </div>
    );
  }

  return (
    <div>
      <label className="font-serif text-sh-black mb-1 block">Vendor</label>
      <select
        name="vendorId"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border p-2 w-full"
        required
      >
        <option value="">Select Vendor</option>
        {/* CORRECTED: Add defensive check before mapping */}
        {(vendors || []).map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </div>
  );
}
