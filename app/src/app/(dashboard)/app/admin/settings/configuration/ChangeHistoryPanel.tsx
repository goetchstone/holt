"use client";

// /app/src/app/(dashboard)/app/admin/settings/configuration/ChangeHistoryPanel.tsx
//
// The audit view over ConfigChangeLog: when, who, from which door (source),
// what action, what changed. Append-only, paginated newest-first, same
// history/pagination shape as PosImportView.tsx's import log.

import { useCallback, useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { getErrorMessage } from "@/lib/toastError";
import { fetchConfigChanges } from "./configClient";

const ACTION_VARIANT: Record<string, BadgeVariant> = {
  APPLIED: "success",
  UNCHANGED: "neutral",
  FAILED: "danger",
};

const PAGE_SIZE = 25;

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString();
}

function summaryText(summary: unknown): string {
  if (!summary || typeof summary !== "object") return "";
  const s = summary as Record<string, unknown>;
  const changes = s.changes as { created?: number; updated?: number; deleted?: number } | undefined;
  if (changes) {
    return `+${changes.created ?? 0} created, ${changes.updated ?? 0} updated, -${changes.deleted ?? 0} deleted`;
  }
  if (typeof s.reason === "string") return s.reason;
  return "";
}

export function ChangeHistoryPanel() {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<
    Array<{
      id: number;
      presetKind: string;
      presetName: string;
      action: string;
      source: string;
      summary: unknown;
      actor: string | null;
      created: string;
    }>
  >([]);
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 });
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const data = await fetchConfigChanges(p, PAGE_SIZE);
      setRows(data.changes);
      setPagination(data.pagination);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load change history"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(page);
  }, [load, page]);

  return (
    <div className="space-y-4">
      {loading && rows.length === 0 ? (
        <div className="flex items-center gap-2 p-4 text-sh-gray">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading history…
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-sh-brand-gray">
          <table className="w-full text-sm">
            <thead className="bg-sh-linen text-left">
              <tr>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Preset</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Actor</th>
                <th className="px-3 py-2">Summary</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-sh-brand-gray">
                  <td className="whitespace-nowrap px-3 py-2">{formatWhen(row.created)}</td>
                  <td className="px-3 py-2">
                    {row.presetKind}/{row.presetName}
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant={ACTION_VARIANT[row.action] ?? "neutral"}>{row.action}</Badge>
                  </td>
                  <td className="px-3 py-2">{row.source}</td>
                  <td className="px-3 py-2">{row.actor ?? "unattended"}</td>
                  <td className="max-w-md px-3 py-2 text-xs text-sh-gray">{summaryText(row.summary)}</td>
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td className="px-3 py-4 text-sh-gray" colSpan={6}>
                    No configuration changes logged yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {pagination.totalPages > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span>
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pagination.totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
