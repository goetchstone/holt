"use client";

// /app/src/app/(dashboard)/app/admin/login-activity/LoginActivityView.tsx
//
// Login Activity body. App Router port of the legacy admin/login-activity page
// (minus MainLayout chrome, supplied by the (dashboard) layout). Shows every
// active staff member with last-login + last-seen, sorted so anyone working
// bubbles to the top. Auto-refreshes every 30s via the shared
// /api/admin/login-activity REST endpoint.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { getErrorMessage } from "@/lib/toastError";
import {
  isActiveNow,
  formatLastSeen,
  type LoginActivityRow,
  type LoginActivityResponse,
} from "@/lib/loginActivity";

const REFRESH_INTERVAL_MS = 30_000;

/**
 * Tiny status pill. Active-now users show a green dot + "Active now" label;
 * otherwise the formatted last-seen ("just now", "5m ago", "Apr 14").
 */
function StatusBadge({ row }: Readonly<{ row: LoginActivityRow }>) {
  if (isActiveNow(row.lastSeenAt)) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-700">
        <span className="inline-block w-2 h-2 rounded-full bg-green-600 animate-pulse" />
        <span>Active now</span>
      </span>
    );
  }
  return <span className="text-xs text-sh-gray">{formatLastSeen(row.lastSeenAt)}</span>;
}

function LastLoginCell({ row }: Readonly<{ row: LoginActivityRow }>) {
  if (!row.lastLoginAt) {
    return <span className="text-sh-gray/60 italic">never logged in</span>;
  }
  return (
    <span title={new Date(row.lastLoginAt).toLocaleString()}>
      {formatLastSeen(row.lastLoginAt)}
    </span>
  );
}

export function LoginActivityView() {
  const [data, setData] = useState<LoginActivityResponse | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await axios.get<LoginActivityResponse>("/api/admin/login-activity", {
        params: includeInactive ? { includeInactive: "true" } : undefined,
      });
      setData(res.data);
      setError(null);
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Failed to load login activity."));
    } finally {
      setLoading(false);
    }
  }, [includeInactive]);

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const rows = data?.staff ?? [];
  const activeCount = rows.filter((r) => isActiveNow(r.lastSeenAt)).length;

  return (
    <div className="py-2 font-serif space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-sh-blue">Login Activity</h1>
        <p className="text-sh-gray text-sm mt-1">
          Who has been using the system. The list refreshes every 30 seconds.
        </p>
      </div>

      <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm p-4 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <span className="inline-block w-2 h-2 rounded-full bg-green-600" />
          <span className="text-sm">
            <span className="font-semibold text-sh-black">{activeCount}</span>{" "}
            <span className="text-sh-gray">active now</span>
            <span className="text-sh-gray"> · </span>
            <span className="font-semibold text-sh-black">{rows.length}</span>{" "}
            <span className="text-sh-gray">total</span>
          </span>
        </div>
        <label
          htmlFor="include-inactive"
          className="ml-auto inline-flex items-center gap-2 text-sm text-sh-gray cursor-pointer"
        >
          <input
            id="include-inactive"
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
            className="w-4 h-4"
          />
          <span>Include inactive staff</span>
        </label>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm p-3 rounded">
          {error}
        </div>
      )}

      {loading && !data && <p className="text-sh-gray text-center py-8">Loading…</p>}
      {!loading && rows.length === 0 && (
        <p className="text-sh-gray text-center py-8">No staff to show.</p>
      )}
      {rows.length > 0 && (
        <div className="bg-white border border-sh-gray/20 rounded-lg shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-sh-linen border-b border-sh-gray/20">
                <th className="text-left p-3 font-semibold text-sh-black">Name</th>
                <th className="text-left p-3 font-semibold text-sh-black">Email</th>
                <th className="text-left p-3 font-semibold text-sh-black">Role</th>
                <th className="text-left p-3 font-semibold text-sh-black">Last Login</th>
                <th className="text-left p-3 font-semibold text-sh-black">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={`border-b border-sh-gray/10 ${row.isActive ? "" : "opacity-60"} ${
                    isActiveNow(row.lastSeenAt) ? "bg-green-50/40" : "hover:bg-sh-stripe"
                  }`}
                >
                  <td className="p-3 text-sh-black font-medium">
                    {row.displayName}
                    {!row.isActive && (
                      <span className="ml-2 text-xs uppercase tracking-wide text-sh-gray">
                        inactive
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-sh-gray text-xs">{row.email ?? "—"}</td>
                  <td className="p-3 text-sh-gray text-xs uppercase tracking-wide">{row.role}</td>
                  <td className="p-3 text-sh-gray">
                    <LastLoginCell row={row} />
                  </td>
                  <td className="p-3">
                    <StatusBadge row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
