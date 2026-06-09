"use client";

// /app/src/app/(dashboard)/app/admin/gift-cards/GiftCardsView.tsx
//
// Gift Cards lookup body. App Router port of the legacy admin/gift-cards/index
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Searches
// the shared /api/gift-cards/lookup REST endpoint by barcode or POS code and
// links each row to the detail page.

import { useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

interface GiftCardSummary {
  id: number;
  barcode: string;
  externalCode: string | null;
  initialAmount: number;
  currentBalance: number;
  status: string;
  activatedAt: string | null;
  created: string;
}

const STATUS_BADGE_STYLES: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  REDEEMED: "bg-sh-gray/20 text-sh-gray",
  VOIDED: "bg-red-100 text-red-800",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded-full text-xs font-serif-condensed ${
        STATUS_BADGE_STYLES[status] ?? ""
      }`}
    >
      {status}
    </span>
  );
}

export function GiftCardsView() {
  const router = useRouter();
  const formatMoney = useMoneyFormatter();
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState<GiftCardSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    const q = query.trim();
    if (!q) return;

    setLoading(true);
    setSearched(true);
    try {
      const res = await fetch(`/api/gift-cards/lookup?q=${encodeURIComponent(q)}`);
      if (res.ok) {
        setCards(await res.json());
      } else {
        toast.error(getErrorMessage(await res.json().catch(() => null), "Search failed"));
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Search failed"));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleSearch();
  };

  return (
    <div className="py-2 font-serif">
      <h1 className="text-2xl font-semibold text-sh-blue mb-6">Gift Cards</h1>

      <div className="flex gap-3 mb-6">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-sh-gray" />
          <label htmlFor="gift-card-search" className="sr-only">
            Search gift cards
          </label>
          <input
            id="gift-card-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search by barcode or the POS code..."
            className="w-full border border-sh-gray rounded-lg pl-10 pr-3 py-2 font-serif text-sh-black"
          />
        </div>
        <Button onClick={handleSearch} disabled={loading}>
          {loading ? "Searching..." : "Search"}
        </Button>
        <Button variant="outline" onClick={() => router.push("/app/admin/gift-cards/import")}>
          Import Vouchers
        </Button>
      </div>

      {searched && cards.length === 0 && !loading && (
        <p className="text-sh-gray font-serif text-center py-8">No gift cards found.</p>
      )}

      {cards.length > 0 && (
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-sh-gray/30 text-left">
              <th className="py-3 px-4 font-serif font-semibold text-sh-blue">Barcode</th>
              <th className="py-3 px-4 font-serif font-semibold text-sh-blue">the POS</th>
              <th className="py-3 px-4 font-serif font-semibold text-sh-blue text-right">
                Initial
              </th>
              <th className="py-3 px-4 font-serif font-semibold text-sh-blue text-right">
                Balance
              </th>
              <th className="py-3 px-4 font-serif font-semibold text-sh-blue text-center">
                Status
              </th>
              <th className="py-3 px-4 font-serif font-semibold text-sh-blue">Activated</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((c, i) => (
              <tr
                key={c.id}
                onClick={() => router.push(`/app/admin/gift-cards/${c.id}`)}
                className={`border-b border-sh-gray/10 cursor-pointer hover:bg-sh-linen/50 ${
                  i % 2 === 0 ? "bg-white" : "bg-sh-stripe"
                }`}
              >
                <td className="py-3 px-4 font-serif text-sh-black font-mono text-sm">
                  {c.barcode}
                </td>
                <td className="py-3 px-4 font-serif text-sh-gray">{c.externalCode || "-"}</td>
                <td className="py-3 px-4 font-serif text-sh-black text-right">
                  {formatMoney(c.initialAmount)}
                </td>
                <td className="py-3 px-4 font-serif font-semibold text-sh-blue text-right">
                  {formatMoney(c.currentBalance)}
                </td>
                <td className="py-3 px-4 text-center">
                  <StatusBadge status={c.status} />
                </td>
                <td className="py-3 px-4 font-serif text-sh-gray text-sm">
                  {c.activatedAt ? new Date(c.activatedAt).toLocaleDateString() : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
