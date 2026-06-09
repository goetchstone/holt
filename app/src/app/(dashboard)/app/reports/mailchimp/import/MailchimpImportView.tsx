"use client";

// /app/src/app/(dashboard)/app/reports/mailchimp/import/MailchimpImportView.tsx
//
// Imported Mailchimp campaigns list. App Router port; reads the shared
// /api/mailchimp/campaigns/db REST endpoint (also used by the admin
// mailchimp-sync surface), so it stays REST. Any signed-in user; gated server-side.

import { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import PaginatedTable, { type Column } from "@/components/table/PaginatedTable";
import { getErrorMessage } from "@/lib/toastError";

interface CampaignRow {
  id: string;
  name: string | null;
  subject: string | null;
  sentAt: string | null;
  list?: string | null;
}

interface CampaignsResponse {
  campaigns: CampaignRow[];
}

export function MailchimpImportView() {
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [page, setPage] = useState(1);
  const rowsPerPage = 10;

  useEffect(() => {
    fetchCampaigns();
  }, []);

  async function fetchCampaigns() {
    try {
      const res = await axios.get<CampaignsResponse>("/api/mailchimp/campaigns/db");
      setCampaigns(res.data.campaigns ?? []);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load campaigns"));
    }
  }

  const columns: Column[] = [
    {
      key: "name",
      label: "Campaign Title",
      accessor: "name",
      render: (row: CampaignRow) => (
        <a href={`/app/reports/mailchimp/campaigns/${row.id}`} className="text-sh-blue underline">
          {row.name}
        </a>
      ),
    },
    { key: "subject", label: "Subject", accessor: "subject" },
    { key: "sentAt", label: "Sent", accessor: "sentAt" },
    { key: "list", label: "List", accessor: "list" },
  ];

  const paginated = campaigns.slice((page - 1) * rowsPerPage, page * rowsPerPage);

  return (
    <div className="py-2 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue mb-4">Import Mailchimp Campaigns</h1>
      <PaginatedTable
        data={paginated}
        columns={columns}
        totalCount={campaigns.length}
        onPageChange={setPage}
        currentPage={page}
      />
    </div>
  );
}
