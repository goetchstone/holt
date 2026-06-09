// /app/src/app/(dashboard)/app/admin/email/EmailQueueView.tsx
//
// Admin view of the transactional email queue: SMTP-configured status, per-status
// counts, a "Process now" drain button, and the recent rows with their last
// error. Client component over /api/admin/email-queue + /api/automations/email-queue.
//
// Reference implementation for the design system: PageHeader + Button + Badge,
// no per-page container (the AppShell provides it).

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeVariant } from "@/components/ui/badge";

type EmailStatus = "PENDING" | "SENT" | "FAILED";

interface QueueRow {
  id: number;
  toAddress: string;
  subject: string;
  templateKey: string | null;
  status: EmailStatus;
  attempts: number;
  lastError: string | null;
  sentAt: string | null;
  created: string;
}

const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

const STATUS_VARIANT: Record<EmailStatus, BadgeVariant> = {
  PENDING: "warning",
  SENT: "success",
  FAILED: "danger",
};

export function EmailQueueView() {
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/email-queue");
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to load");
      const data = (await res.json()) as {
        rows: QueueRow[];
        counts: Record<string, number>;
        configured: boolean;
      };
      setRows(data.rows);
      setCounts(data.counts);
      setConfigured(data.configured);
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load email queue"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function processNow() {
    setProcessing(true);
    try {
      const res = await fetch("/api/automations/email-queue", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not process");
      const { summary } = (await res.json()) as {
        summary: { sent: number; failed: number; skipped: number };
      };
      if (summary.skipped > 0) toast.info("SMTP isn't configured yet — nothing sent.");
      else toast.success(`Sent ${summary.sent}, failed ${summary.failed}`);
      await load();
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Could not process email queue"));
    } finally {
      setProcessing(false);
    }
  }

  return (
    <div>
      <PageHeader
        title="Email"
        subtitle="Transactional email queue and SMTP status."
        actions={
          <Button type="button" onClick={processNow} disabled={processing}>
            {processing ? "Processing…" : "Process now"}
          </Button>
        }
      />

      {!configured ? (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          SMTP isn&apos;t configured, so emails stay queued (PENDING) and aren&apos;t sent. Add SMTP
          credentials in{" "}
          <Link href="/app/admin/settings" className="font-medium underline">
            Settings → Integrations
          </Link>{" "}
          (or set the <code>SMTP_*</code> env vars), then Process now.
        </div>
      ) : null}

      <p className="mb-4 text-sm text-sh-gray">
        <span className="text-sh-black">{counts.PENDING ?? 0}</span> pending ·{" "}
        <span className="text-sh-black">{counts.SENT ?? 0}</span> sent ·{" "}
        <span className="text-sh-black">{counts.FAILED ?? 0}</span> failed
      </p>

      {loading ? (
        <p className="text-sh-gray">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sh-gray">No emails queued yet.</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-black/10 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-sh-stripe text-sh-gray">
              <tr>
                <th className="px-3 py-2 font-medium">To</th>
                <th className="px-3 py-2 font-medium">Subject</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-black/5 align-top">
                  <td className="px-3 py-2 text-sh-gray">{r.toAddress}</td>
                  <td className="px-3 py-2 text-sh-black">
                    {r.subject}
                    {r.lastError ? (
                      <span className="block text-xs text-red-700">{r.lastError}</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-xs text-sh-gray">{r.templateKey ?? "—"}</td>
                  <td className="px-3 py-2">
                    <Badge variant={STATUS_VARIANT[r.status]}>
                      {r.status}
                      {r.attempts > 1 ? ` (${r.attempts})` : ""}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-xs text-sh-gray">
                    {dateTimeFmt.format(new Date(r.sentAt ?? r.created))}
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
