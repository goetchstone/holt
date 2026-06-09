"use client";

// /app/src/app/(dashboard)/app/service/house-calls/HouseCallsView.tsx
//
// House calls list (filters, paginated table, expandable scope detail). App
// Router port of the legacy pages/service/house-calls/index.tsx body (minus
// MainLayout chrome, which comes from the (dashboard) layout). Reads the shared
// /api/service/house-calls + staff REST endpoints.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import axios from "axios";
import { toast } from "react-toastify";
import { format } from "date-fns";

interface HouseCall {
  id: number;
  appointmentNumber: string;
  customerName: string;
  designerName: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  duration: number | null;
  storeName: string | null;
  scope: string | null;
  status: string;
}

interface Designer {
  id: number;
  name: string;
}

const STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-sh-gray/20 text-sh-gray",
  SCHEDULED: "bg-blue-100 text-blue-800",
  CONFIRMED: "bg-yellow-100 text-yellow-800",
  IN_PROGRESS: "bg-orange-100 text-orange-800",
  COMPLETED: "bg-green-100 text-green-800",
  CANCELLED: "bg-red-100 text-red-800",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  SCHEDULED: "Scheduled",
  CONFIRMED: "Confirmed",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

const PAGE_SIZE = 20;

export function HouseCallsView() {
  const router = useRouter();
  const [houseCalls, setHouseCalls] = useState<HouseCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [designers, setDesigners] = useState<Designer[]>([]);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  // Filters
  const [designerFilter, setDesignerFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadDesigners = useCallback(async () => {
    try {
      const res = await axios.get("/api/staff");
      const allStaff = Array.isArray(res.data) ? res.data : res.data.staff || [];
      setDesigners(
        allStaff
          .filter(
            (s: any) =>
              s.role === "DESIGNER" ||
              s.role === "MANAGER" ||
              s.role === "ADMIN" ||
              s.role === "SUPER_ADMIN",
          )
          .map((s: any) => ({ id: s.id, name: s.displayName })),
      );
    } catch {
      setDesigners([]);
    }
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string | number> = {
        page,
        limit: PAGE_SIZE,
      };
      if (designerFilter !== "ALL") params.designerId = designerFilter;
      if (statusFilter !== "ALL") params.status = statusFilter;
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;

      const res = await axios.get("/api/service/house-calls", { params });
      setHouseCalls(res.data.houseCalls || []);
      setTotalCount(res.data.total || 0);
    } catch {
      toast.error("Failed to load house calls");
      setHouseCalls([]);
      setTotalCount(0);
    } finally {
      setLoading(false);
    }
  }, [page, designerFilter, statusFilter, dateFrom, dateTo]);

  useEffect(() => {
    loadDesigners();
  }, [loadDesigners]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    setPage(1);
  }, [designerFilter, statusFilter, dateFrom, dateTo]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  return (
    <div className="py-2 space-y-4 font-serif">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl text-sh-blue font-semibold">House Calls</h1>
        <Button onClick={() => router.push("/app/service/house-calls/new")}>New House Call</Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4 bg-white rounded-lg border border-sh-gray/20 shadow-sm p-4">
        <div>
          <label className="block text-xs font-medium text-sh-gray mb-1">Designer</label>
          <select
            className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-w-[180px]"
            value={designerFilter}
            onChange={(e) => setDesignerFilter(e.target.value)}
          >
            <option value="ALL">All Designers</option>
            {designers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-sh-gray mb-1">Status</label>
          <select
            className="border border-sh-gray/30 rounded px-3 py-2 text-sm min-w-[160px]"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="ALL">All Statuses</option>
            {Object.entries(STATUS_LABELS).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-sh-gray mb-1">From</label>
          <input
            type="date"
            className="border border-sh-gray/30 rounded px-3 py-2 text-sm"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-sh-gray mb-1">To</label>
          <input
            type="date"
            className="border border-sh-gray/30 rounded px-3 py-2 text-sm"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <p className="text-sh-gray">Loading...</p>
      ) : (
        <div className="bg-white rounded-lg border border-sh-gray/20 shadow-md overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-sh-gray/20 bg-sh-stripe">
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Appt #</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Customer</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Designer</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[130px]">
                  Date/Time
                </th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[80px]">Duration</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Store</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray">Scope</th>
                <th className="text-left px-4 py-3 font-medium text-sh-gray w-[110px]">Status</th>
              </tr>
            </thead>
            <tbody>
              {houseCalls.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sh-gray">
                    No house calls found
                  </td>
                </tr>
              ) : (
                houseCalls.map((hc) => (
                  <>
                    <tr
                      key={hc.id}
                      className="border-b border-sh-gray/10 hover:bg-sh-stripe/50 cursor-pointer"
                      onClick={() => setExpandedId(expandedId === hc.id ? null : hc.id)}
                    >
                      <td className="px-4 py-2 text-sh-black font-medium">
                        {hc.appointmentNumber}
                      </td>
                      <td className="px-4 py-2 text-sh-gray">{hc.customerName}</td>
                      <td className="px-4 py-2 text-sh-gray">{hc.designerName || "--"}</td>
                      <td className="px-4 py-2 text-sh-gray text-xs">
                        {hc.scheduledDate
                          ? format(new Date(hc.scheduledDate), "MMM d, yyyy")
                          : "--"}
                        {hc.scheduledTime ? ` ${hc.scheduledTime}` : ""}
                      </td>
                      <td className="px-4 py-2 text-sh-gray text-xs">
                        {hc.duration ? `${hc.duration}hr` : "--"}
                      </td>
                      <td className="px-4 py-2 text-sh-gray">{hc.storeName || "--"}</td>
                      <td className="px-4 py-2 text-sh-gray text-xs max-w-[200px] truncate">
                        {hc.scope || "--"}
                      </td>
                      <td className="px-4 py-2">
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${STATUS_STYLES[hc.status] || "bg-sh-gray/20 text-sh-gray"}`}
                        >
                          {STATUS_LABELS[hc.status] || hc.status}
                        </span>
                      </td>
                    </tr>
                    {expandedId === hc.id && (
                      <tr
                        key={`${hc.id}-detail`}
                        className="border-b border-sh-gray/10 bg-sh-linen"
                      >
                        <td colSpan={8} className="px-4 py-4">
                          <div className="text-sm text-sh-gray space-y-1">
                            <p>
                              <span className="font-medium text-sh-black">Scope:</span>{" "}
                              {hc.scope || "None provided"}
                            </p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-sh-gray/20">
              <p className="text-xs text-sh-gray">
                Showing {(page - 1) * PAGE_SIZE + 1}--
                {Math.min(page * PAGE_SIZE, totalCount)} of {totalCount}
              </p>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
