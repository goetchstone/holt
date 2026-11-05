"use client";

// /app/src/app/(dashboard)/app/sales/clients/ClientsView.tsx
//
// A salesperson's client book: everyone they have sold to or quoted, with their
// notes and what's on file, so they can work past clients as well as open quotes.
// Managers can open any salesperson's book.

import { useEffect, useState } from "react";
import axios from "axios";
import Link from "next/link";
import { toast } from "react-toastify";
import { BulkAssignBar } from "@/components/pipeline/BulkAssignBar";
import { ClientBookCard } from "@/components/pipeline/ClientBookCard";
import { ClientInfoModal } from "@/components/pipeline/ClientInfoModal";
import { ClientNoteModal } from "@/components/pipeline/ClientNoteModal";
import { LogContactModal } from "@/components/pipeline/LogContactModal";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { api } from "@/lib/trpc/client";
import { usePersistentFilters } from "@/hooks/usePersistentFilters";
import {
  CLIENT_BOOK_SORTS,
  CLIENT_FOLLOW_UP_VIEWS,
  CLIENT_NOTE_FILTERS,
  LAST_ORDER_FILTERS,
  UNASSIGNED_STAFF_ID,
  type ClientBookSort,
  type ClientNoteFilter,
  type ClientFollowUpView,
  type LastOrderFilter,
  type OutreachRules,
} from "@/lib/clientBook";
import type { ClientBookRow } from "@/lib/clientBookQuery";
import { getErrorMessage } from "@/lib/toastError";
import type { ClientBookResponse } from "@/pages/api/sales/clients/index";

const SELECT_CLASS =
  "rounded-lg border border-brand-gray/30 bg-white px-3 py-2 text-sm text-brand-black min-h-[44px] focus:border-brand-blue focus:outline-none";

const DEFAULT_FILTERS: {
  lastOrder: LastOrderFilter;
  notes: ClientNoteFilter;
  sort: ClientBookSort;
} = {
  lastOrder: "all",
  notes: "all",
  sort: "recent",
};

function pageHeading(data: ClientBookResponse | null, staffName: string | null): string {
  if (!data || data.staffOptions.length === 0) return "My Clients";
  return staffName ? `${staffName}'s Clients` : "Clients With No Owner";
}

function clientFullName(client: ClientBookRow): string {
  return `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim() || "No name";
}

function SuggestedNote({ rules }: Readonly<{ rules: OutreachRules }>) {
  const money = useMoneyFormatter();
  return (
    <>
      . Past clients who&apos;ve spent {money(rules.minLifetimeSpend, { whole: true })} or more,
      with no order in {rules.lapsedMonths} months, no contact in {rules.quietDays} days and no open
      quote or follow-up date. Biggest first.
    </>
  );
}

export function ClientsView({
  linkedBook,
  linkedView,
}: Readonly<{ linkedBook: string | null; linkedView: ClientFollowUpView }>) {
  const [data, setData] = useState<ClientBookResponse | null>(null);
  const [loadedKey, setLoadedKey] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filters, setFilters] = usePersistentFilters("client-book-filters", DEFAULT_FILTERS);
  const [chosenBook, setChosenBook] = useState<string | null>(null);
  const [workedWith, setWorkedWith] = useState("");
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);
  const [noteTarget, setNoteTarget] = useState<ClientBookRow | null>(null);
  const [infoTarget, setInfoTarget] = useState<ClientBookRow | null>(null);
  const [contactTarget, setContactTarget] = useState<ClientBookRow | null>(null);
  const [followUp, setFollowUp] = useState<ClientFollowUpView>(linkedView);
  const setMorningEmail = api.account.setFollowUpEmail.useMutation();

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  // The pipeline's All Staff page links straight to the unassigned list.
  const openBook = chosenBook ?? linkedBook;

  const requestParams = JSON.stringify({
    ...filters,
    followUp,
    page,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(openBook ? { staffId: openBook } : {}),
    ...(workedWith ? { workedWith } : {}),
  });
  const requestKey = `${requestParams}#${refreshKey}`;
  const loading = loadedKey !== requestKey;

  useEffect(() => {
    let isCurrent = true;
    axios
      .get<ClientBookResponse>("/api/sales/clients", { params: JSON.parse(requestParams) })
      .then((res) => {
        if (isCurrent) setData(res.data);
      })
      .catch((err) => {
        if (isCurrent) toast.error(getErrorMessage(err, "Failed to load clients."));
      })
      .finally(() => {
        if (isCurrent) setLoadedKey(requestKey);
      });
    // A newer request replaces this one, so a slow older response can't overwrite it.
    return () => {
      isCurrent = false;
    };
  }, [requestParams, requestKey]);

  function changeFilters(changes: Partial<typeof DEFAULT_FILTERS>) {
    setFilters({ ...filters, ...changes });
    setPage(1);
  }

  function refreshAfterSave() {
    setNoteTarget(null);
    setInfoTarget(null);
    setRefreshKey((key) => key + 1);
  }

  async function handleAssign(client: ClientBookRow, toStaffId: number) {
    try {
      const { data: result } = await axios.post("/api/sales/clients/assign", {
        customerId: client.id,
        toStaffId,
      });
      toast.success(`${clientFullName(client)} assigned to ${result.toStaff}.`);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to assign client."));
    }
  }

  async function handleBulkAssign(toStaffId: number) {
    if (!data) return;
    try {
      const { data: result } = await axios.post("/api/sales/clients/assign", {
        ...JSON.parse(requestParams),
        toStaffId,
        expectedCount: data.total,
      });
      toast.success(
        `${result.clientCount.toLocaleString("en-US")} clients assigned to ${result.toStaff}.`,
      );
      setWorkedWith("");
      setPage(1);
      setRefreshKey((key) => key + 1);
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to assign clients."));
    }
  }

  const listsUnassigned = data !== null && data.staff === null;
  const staffName = data?.staff?.displayName ?? null;
  const lastPage = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <div className="py-2 space-y-5 font-serif">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold text-brand-blue">{pageHeading(data, staffName)}</h1>
          <Link href="/app/sales/pipeline" className="text-sm text-brand-blue hover:underline">
            Open quotes in the Pipeline →
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, notes, keywords, brands…"
            aria-label="Search clients by name, phone, email, notes, keywords or brands"
            className="w-72 rounded-lg border border-brand-gray/30 px-3 py-2 text-sm min-h-[44px] focus:border-brand-blue focus:outline-none"
          />
          {data && data.staffOptions.length > 0 && (
            <select
              aria-label="Salesperson"
              value={data.staff?.id ?? UNASSIGNED_STAFF_ID}
              onChange={(e) => {
                setChosenBook(e.target.value);
                setWorkedWith("");
                setPage(1);
              }}
              className={SELECT_CLASS}
            >
              <option value={UNASSIGNED_STAFF_ID}>No owner (assign clients)</option>
              {data.staffOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.displayName}
                </option>
              ))}
            </select>
          )}
          {listsUnassigned && (
            <select
              aria-label="Worked with"
              value={workedWith}
              onChange={(e) => {
                setWorkedWith(e.target.value);
                setPage(1);
              }}
              className={SELECT_CLASS}
            >
              <option value="">Worked with anyone</option>
              {data.workedWithOptions.map((option) => (
                <option key={option.name} value={option.name}>
                  {option.name} ({option.clientCount.toLocaleString("en-US")})
                </option>
              ))}
            </select>
          )}
          {data && (
            <>
              <select
                aria-label="Show"
                value={followUp}
                onChange={(e) => {
                  setFollowUp(e.target.value as ClientFollowUpView);
                  setPage(1);
                }}
                className={SELECT_CLASS}
              >
                {CLIENT_FOLLOW_UP_VIEWS.filter(
                  (view) =>
                    view.value !== "suggested" || (!listsUnassigned && data.outreach !== null),
                ).map((view) => (
                  <option key={view.value} value={view.value}>
                    {view.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Last order"
                value={filters.lastOrder}
                onChange={(e) => changeFilters({ lastOrder: e.target.value as LastOrderFilter })}
                className={SELECT_CLASS}
              >
                {LAST_ORDER_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Notes"
                value={filters.notes}
                onChange={(e) => changeFilters({ notes: e.target.value as ClientNoteFilter })}
                className={SELECT_CLASS}
              >
                {CLIENT_NOTE_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {followUp !== "suggested" && (
                <select
                  aria-label="Sort clients"
                  value={filters.sort}
                  onChange={(e) => changeFilters({ sort: e.target.value as ClientBookSort })}
                  className={SELECT_CLASS}
                >
                  {CLIENT_BOOK_SORTS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
        </div>

        {data && data.morningEmailOn !== null && !openBook && (
          <label className="flex items-center gap-2 text-xs text-brand-gray">
            <input
              type="checkbox"
              checked={data.morningEmailOn}
              disabled={setMorningEmail.isPending}
              onChange={(e) =>
                setMorningEmail.mutate(
                  { on: e.target.checked },
                  {
                    onSuccess: () => refreshAfterSave(),
                    onError: (err) =>
                      toast.error(getErrorMessage(err, "Could not change your morning email.")),
                  },
                )
              }
            />
            Email me my follow-ups each morning
          </label>
        )}

        {data && (
          <p className="text-xs text-brand-gray">
            {data.total.toLocaleString("en-US")} client{data.total === 1 ? "" : "s"}
            {followUp === "suggested" && data.outreach && <SuggestedNote rules={data.outreach} />}
            {listsUnassigned &&
              ". No active salesperson owns these clients, or they have a quote in nobody's pipeline."}
          </p>
        )}

        {listsUnassigned && workedWith && data.total > 0 && (
          <BulkAssignBar
            clientCount={data.total}
            workedWith={workedWith}
            options={data.assignOptions}
            onAssign={handleBulkAssign}
          />
        )}

        {!data && (
          <div className="text-brand-gray text-sm animate-pulse py-8 text-center">
            Loading clients...
          </div>
        )}

        {!loading && data && data.rows.length === 0 && (
          <p className="text-brand-gray text-sm text-center py-16">No clients match.</p>
        )}

        {/* Stays on screen while reloading, so assigning a client doesn't lose your place. */}
        {data && (
          <section className={`space-y-3 transition-opacity ${loading ? "opacity-60" : ""}`}>
            {data.rows.map((client) => (
              <ClientBookCard
                key={client.id}
                client={client}
                staffName={staffName}
                searchTerm={debouncedSearch}
                assignOptions={data.assignOptions}
                onAssign={handleAssign}
                onAddNote={setNoteTarget}
                onClientInfo={setInfoTarget}
                onLogContact={setContactTarget}
              />
            ))}
          </section>
        )}

        {!loading && data && lastPage > 1 && (
          <div className="flex items-center justify-center gap-3">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              className="rounded-lg border border-brand-gray/30 px-4 min-h-[44px] text-sm text-brand-blue disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-xs text-brand-gray">
              Page {page} of {lastPage}
            </span>
            <button
              type="button"
              disabled={page >= lastPage}
              onClick={() => setPage(page + 1)}
              className="rounded-lg border border-brand-gray/30 px-4 min-h-[44px] text-sm text-brand-blue disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>

      {noteTarget && (
        <ClientNoteModal
          customerId={noteTarget.id}
          title={clientFullName(noteTarget)}
          onClose={() => setNoteTarget(null)}
          onSaved={refreshAfterSave}
        />
      )}

      {contactTarget && data && (
        <LogContactModal
          customerId={contactTarget.id}
          title={clientFullName(contactTarget)}
          dateOnFile={contactTarget.profile?.nextFollowUpDate ?? null}
          canSchedule
          today={data.today}
          onClose={() => setContactTarget(null)}
          onSaved={refreshAfterSave}
        />
      )}

      {infoTarget && (
        <ClientInfoModal
          customerId={infoTarget.id}
          customerName={clientFullName(infoTarget)}
          onClose={() => setInfoTarget(null)}
          onSaved={refreshAfterSave}
        />
      )}
    </>
  );
}
