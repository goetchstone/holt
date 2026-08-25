"use client";

// /app/src/app/(dashboard)/app/warehouse/dashboard/WarehouseDashboardView.tsx
//
// Warehouse dashboard body (summary cards, inventory-by-location grid, inbound
// PO table). App Router port of the legacy pages/warehouse/dashboard.tsx body
// (minus MainLayout chrome, which comes from the (dashboard) layout). Reads the
// shared /api/warehouse/dashboard/* REST endpoints.

import { useState, useEffect } from "react";
import axios from "axios";

interface LocationSummary {
  id: number;
  name: string;
  code: string;
  type: string;
  totalItems: number;
  stockLocationBreakdown: Record<string, { name: string; quantity: number }>;
}

interface InboundPO {
  id: number;
  poNumber: string;
  vendorName: string;
  status: string;
  expectedDelivery: string | null;
  itemCount: number;
  pendingItems: number;
}

export function WarehouseDashboardView() {
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [inbound, setInbound] = useState<InboundPO[]>([]);
  const [transfersInTransit, setTransfersInTransit] = useState(0);
  const [pendingDispatch, setPendingDispatch] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      try {
        const [summaryRes, inboundRes] = await Promise.all([
          axios.get("/api/warehouse/dashboard/summary"),
          axios.get("/api/warehouse/dashboard/inbound"),
        ]);
        setLocations(summaryRes.data.locations);
        setTransfersInTransit(summaryRes.data.transfersInTransit);
        setPendingDispatch(summaryRes.data.pendingDispatch);
        setInbound(inboundRes.data.inbound);
      } catch {
        // Silent fail -- dashboard shows empty state
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  if (loading) {
    return (
      <div className="py-2 font-serif">
        <h1 className="text-2xl text-brand-blue font-semibold mb-6">Warehouse Dashboard</h1>
        <p className="text-brand-gray">Loading...</p>
      </div>
    );
  }

  return (
    <div className="py-2 space-y-8 font-serif">
      <h1 className="text-2xl text-brand-blue font-semibold">Warehouse Dashboard</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg border border-brand-gray/20 shadow-md p-5">
          <p className="text-sm text-brand-gray">In Transit</p>
          <p className="text-2xl font-semibold text-brand-black">{transfersInTransit}</p>
        </div>
        <div className="bg-white rounded-lg border border-brand-gray/20 shadow-md p-5">
          <p className="text-sm text-brand-gray">Pending Dispatch</p>
          <p className="text-2xl font-semibold text-brand-black">{pendingDispatch}</p>
        </div>
        <div className="bg-white rounded-lg border border-brand-gray/20 shadow-md p-5">
          <p className="text-sm text-brand-gray">Inbound POs</p>
          <p className="text-2xl font-semibold text-brand-black">{inbound.length}</p>
        </div>
      </div>

      {/* Location inventory cards */}
      <div>
        <h2 className="text-lg text-brand-black font-semibold mb-3">Inventory by Location</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {locations.map((loc) => (
            <div
              key={loc.id}
              className="bg-white rounded-lg border border-brand-gray/20 shadow-md p-5"
            >
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-brand-black">{loc.name}</h3>
                <span className="text-xs px-2 py-0.5 rounded bg-brand-gray/10 text-brand-gray">
                  {loc.code}
                </span>
              </div>
              <p className="text-2xl font-semibold text-brand-blue mb-2">{loc.totalItems}</p>
              {loc.totalItems > 0 && (
                <div className="space-y-1">
                  {Object.values(loc.stockLocationBreakdown).map((entry) => (
                    <div key={entry.name} className="flex justify-between text-sm text-brand-gray">
                      <span>{entry.name}</span>
                      <span className="font-medium">{entry.quantity}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Inbound POs */}
      {inbound.length > 0 && (
        <div>
          <h2 className="text-lg text-brand-black font-semibold mb-3">Inbound Purchase Orders</h2>
          <div className="bg-white rounded-lg border border-brand-gray/20 shadow-md overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-brand-gray/20 bg-brand-stripe">
                  <th className="text-left px-4 py-3 font-medium text-brand-gray">PO #</th>
                  <th className="text-left px-4 py-3 font-medium text-brand-gray">Vendor</th>
                  <th className="text-left px-4 py-3 font-medium text-brand-gray">Status</th>
                  <th className="text-right px-4 py-3 font-medium text-brand-gray">Pending</th>
                </tr>
              </thead>
              <tbody>
                {inbound.map((po) => (
                  <tr key={po.id} className="border-b border-brand-gray/10">
                    <td className="px-4 py-2 text-brand-black">{po.poNumber}</td>
                    <td className="px-4 py-2 text-brand-gray">{po.vendorName}</td>
                    <td className="px-4 py-2">
                      <span className="text-xs px-2 py-0.5 rounded bg-yellow-100 text-yellow-800">
                        {po.status === "CONFIRMED" ? "Confirmed" : "Submitted"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-right text-brand-gray">
                      {po.pendingItems} / {po.itemCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
