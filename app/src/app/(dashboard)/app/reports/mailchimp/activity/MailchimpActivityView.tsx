"use client";

// /app/src/app/(dashboard)/app/reports/mailchimp/activity/MailchimpActivityView.tsx
//
// Mailchimp Activity Log -- raw open/click/bounce events. App Router port;
// reads the shared /api/mailchimp/* REST endpoints (also used by the admin
// mailchimp-sync surface), so those stay REST. Any signed-in user; gated
// server-side. Replicates StandardListPage's behavior (search + pagination)
// without its MainLayout chrome, since the (dashboard) layout supplies chrome.

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { format } from "date-fns";
import { Eye, Download } from "lucide-react";
import TableWithFilters from "@/components/table/TableWithFilters";
import { Button } from "@/components/ui/button";
import { type Column } from "@/components/table/PaginatedTable";

interface ActivityRow {
  email: string;
  action: string;
  timestamp: string;
  customerFullName?: string;
  campaignName?: string | null;
  campaignId?: string | null;
}

export function MailchimpActivityView() {
  const router = useRouter();
  const [data, setData] = useState<ActivityRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [syncingAllActivity, setSyncingAllActivity] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/mailchimp/activities?page=${page}&limit=10&search=${encodeURIComponent(search)}`,
      );
      const json = await res.json();
      setData(json.activity || []);
      setTotal(json.total || 0);
    } catch {
      toast.error("Failed to load activity");
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSearchChange = (newSearchTerm: string) => {
    setPage(1);
    setSearch(newSearchTerm);
  };

  const handleSyncAllActivity = async () => {
    setSyncingAllActivity(true);
    try {
      const res = await fetch("/api/mailchimp/sync-all-activity", { method: "POST" });
      if (res.ok) {
        toast.success("All Mailchimp activity synced successfully!");
        loadData();
      } else {
        const errorData = await res.json().catch(() => ({}));
        toast.error(`Failed to sync all activity: ${errorData.error || "Unknown error"}`);
      }
    } catch {
      toast.error("Error occurred while syncing all activity.");
    } finally {
      setSyncingAllActivity(false);
    }
  };

  const columns: Column[] = [
    { key: "email", label: "Email", accessor: "email", width: "200px" },
    { key: "customerFullName", label: "Customer", accessor: "customerFullName", width: "150px" },
    { key: "campaignName", label: "Campaign", accessor: "campaignName", width: "200px" },
    { key: "action", label: "Action", accessor: "action", width: "120px" },
    {
      key: "timestamp",
      label: "Timestamp",
      accessor: "timestamp",
      width: "180px",
      render: (row: ActivityRow) => format(new Date(row.timestamp), "PPP p"),
    },
    {
      key: "actions",
      label: "Actions",
      accessor: "campaignId",
      width: "120px",
      render: (row: ActivityRow) => (
        <div className="flex space-x-2">
          {row.campaignId && (
            <Button
              variant="outline"
              onClick={(e) => {
                e.stopPropagation();
                router.push(`/app/reports/mailchimp/campaigns/${row.campaignId}`);
              }}
            >
              View Campaign <Eye className="w-4 h-4 ml-2" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="py-2 font-serif text-sh-black">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-semibold text-sh-blue">Mailchimp Activity Log</h1>
        <Button variant="primary" onClick={handleSyncAllActivity} disabled={syncingAllActivity}>
          {syncingAllActivity ? "Syncing All Activity..." : "Sync All Activity"}{" "}
          <Download className="w-4 h-4 ml-2" />
        </Button>
      </div>

      <TableWithFilters<ActivityRow>
        data={data}
        columns={columns}
        searchFields={[]}
        storageKey="mailchimpActivities"
        total={total}
        page={page}
        onPageChange={setPage}
        loading={loading}
        onRowClick={(row) =>
          row.campaignId
            ? router.push(`/app/reports/mailchimp/campaigns/${row.campaignId}`)
            : undefined
        }
        onSearchChange={handleSearchChange}
      />
    </div>
  );
}
