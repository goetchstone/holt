"use client";

// /app/src/app/(dashboard)/app/warehouse/positions/InventoryPositionsView.tsx
//
// Inventory positions body (search + store/stock-location filters + paginated
// table). App Router port of the legacy pages/warehouse/positions.tsx body
// (minus MainLayout chrome, which comes from the (dashboard) layout). Reads the
// shared /api/warehouse/locations + /api/warehouse/positions REST endpoints.

import { useState, useEffect, useCallback } from "react";
import axios from "axios";
import { format } from "date-fns";

interface PositionRow {
  id: number;
  productId: number;
  productName: string;
  productNumber: string;
  storeLocationId: number;
  locationName: string;
  locationCode: string;
  stockLocationId: number | null;
  stockLocationName: string | null;
  stockLocationCode: string | null;
  quantity: number;
  salesOrderId: number | null;
  salesOrderNo: string | null;
  notes: string | null;
  updated: string;
}

interface StockLocationOption {
  id: number;
  code: string;
  name: string;
}

interface LocationOption {
  id: number;
  name: string;
  code: string;
  stockLocations: StockLocationOption[];
}

export function InventoryPositionsView() {
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [stockLocationFilter, setStockLocationFilter] = useState("");
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [loading, setLoading] = useState(true);

  const limit = 25;

  useEffect(() => {
    axios.get("/api/warehouse/locations").then((res) => {
      setLocations(res.data.locations);
    });
  }, []);

  const fetchPositions = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = { page, limit, search };
      if (locationFilter) params.locationId = locationFilter;
      if (stockLocationFilter) params.stockLocationId = stockLocationFilter;

      const res = await axios.get("/api/warehouse/positions", { params });
      setPositions(res.data.positions);
      setTotal(res.data.total);
    } catch {
      setPositions([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, search, locationFilter, stockLocationFilter]);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  const totalPages = Math.ceil(total / limit);

  // Get stock locations for the selected store location filter
  const selectedLocation = locationFilter
    ? locations.find((l) => l.id === Number.parseInt(locationFilter))
    : null;
  const filteredStockLocations = selectedLocation?.stockLocations || [];

  return (
    <div className="py-2 space-y-4 font-serif">
      <h1 className="text-2xl text-sh-blue font-semibold">Inventory by Location</h1>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label htmlFor="positions-search" className="block text-xs text-sh-gray mb-1">
            Search
          </label>
          <input
            id="positions-search"
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Product name or number..."
            className="border border-sh-gray/30 rounded px-3 py-2 text-sm w-56"
          />
        </div>
        <div>
          <label htmlFor="positions-location" className="block text-xs text-sh-gray mb-1">
            Location
          </label>
          <select
            id="positions-location"
            value={locationFilter}
            onChange={(e) => {
              setLocationFilter(e.target.value);
              setStockLocationFilter("");
              setPage(1);
            }}
            className="border border-sh-gray/30 rounded px-3 py-2 text-sm"
          >
            <option value="">All Locations</option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
        </div>
        {filteredStockLocations.length > 0 && (
          <div>
            <label htmlFor="positions-stock-location" className="block text-xs text-sh-gray mb-1">
              Stock Location
            </label>
            <select
              id="positions-stock-location"
              value={stockLocationFilter}
              onChange={(e) => {
                setStockLocationFilter(e.target.value);
                setPage(1);
              }}
              className="border border-sh-gray/30 rounded px-3 py-2 text-sm"
            >
              <option value="">All USLs</option>
              {filteredStockLocations.map((sl) => (
                <option key={sl.id} value={sl.id}>
                  {sl.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-sh-gray/20 bg-sh-stripe">
              <th className="text-left px-4 py-3 font-medium text-sh-gray">Product</th>
              <th className="text-left px-4 py-3 font-medium text-sh-gray w-[130px]">Location</th>
              <th className="text-left px-4 py-3 font-medium text-sh-gray w-[160px]">
                Stock Location
              </th>
              <th className="text-right px-4 py-3 font-medium text-sh-gray w-[60px]">Qty</th>
              <th className="text-left px-4 py-3 font-medium text-sh-gray w-[120px]">
                Sales Order
              </th>
              <th className="text-left px-4 py-3 font-medium text-sh-gray w-[100px]">Updated</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                  Loading...
                </td>
              </tr>
            ) : positions.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-sh-gray">
                  No inventory positions found
                </td>
              </tr>
            ) : (
              positions.map((pos) => (
                <tr key={pos.id} className="border-b border-sh-gray/10">
                  <td className="px-4 py-2">
                    <div className="text-sh-black">{pos.productName}</div>
                    <div className="text-xs text-sh-gray">{pos.productNumber}</div>
                  </td>
                  <td className="px-4 py-2 text-sh-gray">{pos.locationName}</td>
                  <td className="px-4 py-2">
                    {pos.stockLocationName ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-sh-gray/10 text-sh-gray">
                        {pos.stockLocationName}
                      </span>
                    ) : (
                      <span className="text-xs text-sh-gray/50">--</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-sh-black font-medium">{pos.quantity}</td>
                  <td className="px-4 py-2 text-sh-gray text-xs">{pos.salesOrderNo || ""}</td>
                  <td className="px-4 py-2 text-sh-gray text-xs">
                    {pos.updated ? format(new Date(pos.updated), "MMM d") : ""}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-sh-gray">
          <span>
            {total} position{total !== 1 ? "s" : ""}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="px-3 py-1 border border-sh-gray/30 rounded disabled:opacity-40"
            >
              Prev
            </button>
            <span className="px-3 py-1">
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="px-3 py-1 border border-sh-gray/30 rounded disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
