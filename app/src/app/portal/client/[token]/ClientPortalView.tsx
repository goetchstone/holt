"use client";

// /app/src/app/portal/client/[token]/ClientPortalView.tsx
//
// Client hub renderer: appointments, invoices (with Pay Now via Stripe),
// and ticket statuses (linking to the existing support/[token] pages). The
// data arrives server-rendered; the only fetch here is the pay-link POST.

import { useState } from "react";
import type { ClientPortalData } from "@/lib/clientPortal";

const INVOICE_BADGE: Record<string, string> = {
  ISSUED: "bg-amber-100 text-amber-800",
  PAID: "bg-green-100 text-green-800",
};

function fmtDate(iso: string | null, locale: string): string {
  if (!iso) return "--";
  return new Date(iso).toLocaleDateString(locale, { dateStyle: "medium" });
}

function fmtDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function ClientPortalView({
  token,
  data,
  appName,
  currency,
  locale,
}: {
  token: string;
  data: ClientPortalData;
  appName: string;
  currency: string;
  locale: string;
}) {
  const money = new Intl.NumberFormat(locale, { style: "currency", currency });
  const [payingId, setPayingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pay = async (invoiceId: number) => {
    setPayingId(invoiceId);
    setError(null);
    try {
      const res = await fetch("/api/client-portal/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, invoiceId }),
      });
      const body = (await res.json()) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        setError(body.error ?? "Could not start the payment");
        return;
      }
      window.location.href = body.url;
    } catch {
      setError("Could not start the payment");
    } finally {
      setPayingId(null);
    }
  };

  const upcoming = data.appointments.filter((a) => new Date(a.startsAt) >= new Date());
  const past = data.appointments.filter((a) => new Date(a.startsAt) < new Date()).slice(0, 5);

  return (
    <div className="mx-auto max-w-2xl space-y-10 px-4 py-10 font-serif">
      <header>
        <p className="text-sm uppercase tracking-wide text-sh-gray">{appName}</p>
        <h1 className="text-2xl font-semibold text-sh-navy">Welcome, {data.customerName}</h1>
        <p className="text-sm text-sh-gray">
          Your appointments, invoices, and support requests — all in one place.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-sh-navy">Appointments</h2>
        {upcoming.length === 0 && past.length === 0 && (
          <p className="text-sm text-sh-gray">No appointments yet.</p>
        )}
        {upcoming.length > 0 && (
          <ul className="space-y-2">
            {upcoming.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between rounded-lg border border-sh-gray/20 bg-white px-4 py-3"
              >
                <div>
                  <div className="font-semibold text-sh-navy">{a.serviceName ?? "Appointment"}</div>
                  <div className="text-sm text-sh-gray">{fmtDateTime(a.startsAt, locale)}</div>
                </div>
                <span className="rounded-full bg-sh-stripe px-2 py-1 text-xs text-sh-gray">
                  {a.status}
                </span>
              </li>
            ))}
          </ul>
        )}
        {past.length > 0 && (
          <details className="mt-2">
            <summary className="cursor-pointer text-sm text-sh-gray">Past appointments</summary>
            <ul className="mt-2 space-y-1">
              {past.map((a) => (
                <li key={a.id} className="text-sm text-sh-gray">
                  {fmtDateTime(a.startsAt, locale)} · {a.serviceName ?? "Appointment"}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-sh-navy">Invoices</h2>
        {error && (
          <p className="mb-2 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        {data.invoices.length === 0 && <p className="text-sm text-sh-gray">No invoices yet.</p>}
        <ul className="space-y-2">
          {data.invoices.map((inv) => (
            <li
              key={inv.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sh-gray/20 bg-white px-4 py-3"
            >
              <div>
                <div className="font-semibold text-sh-navy">
                  {inv.invoiceNo}{" "}
                  <span
                    className={`ml-1 rounded-full px-2 py-0.5 text-xs ${INVOICE_BADGE[inv.status] ?? ""}`}
                  >
                    {inv.status === "ISSUED" ? "DUE" : inv.status}
                  </span>
                </div>
                <div className="text-sm text-sh-gray">
                  {fmtDate(inv.invoiceDate, locale)}
                  {inv.dueDate ? ` · due ${fmtDate(inv.dueDate, locale)}` : ""} ·{" "}
                  {money.format(inv.total)}
                </div>
              </div>
              {inv.status === "ISSUED" && inv.openBalance > 0 && (
                <button
                  type="button"
                  onClick={() => pay(inv.id)}
                  disabled={payingId !== null}
                  className="min-h-[44px] rounded-lg bg-sh-navy px-5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
                >
                  {payingId === inv.id ? "Opening..." : `Pay ${money.format(inv.openBalance)}`}
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold text-sh-navy">Support Requests</h2>
        {data.tickets.length === 0 && (
          <p className="text-sm text-sh-gray">No support requests yet.</p>
        )}
        <ul className="space-y-2">
          {data.tickets.map((t) => (
            <li
              key={t.ticketNumber}
              className="flex items-center justify-between rounded-lg border border-sh-gray/20 bg-white px-4 py-3"
            >
              <div>
                <a
                  href={`/support/${t.statusToken}`}
                  className="font-semibold text-sh-navy hover:underline"
                >
                  [{t.ticketNumber}] {t.subject}
                </a>
                <div className="text-sm text-sh-gray">{fmtDate(t.created, locale)}</div>
              </div>
              <span className="rounded-full bg-sh-stripe px-2 py-1 text-xs text-sh-gray">
                {t.status}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <footer className="border-t border-sh-gray/20 pt-4 text-xs text-sh-gray">
        This private link is yours — please don&apos;t share it. Links expire after 30 days; ask us
        for a fresh one anytime.
      </footer>
    </div>
  );
}
