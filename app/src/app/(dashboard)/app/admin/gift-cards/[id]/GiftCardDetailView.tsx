"use client";

// /app/src/app/(dashboard)/app/admin/gift-cards/[id]/GiftCardDetailView.tsx
//
// Gift Card detail body. App Router port of the legacy admin/gift-cards/[id]
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Shows
// the card summary + transaction history and moves a card's balance to a new
// card via the shared /api/gift-cards/[id]/replace REST endpoint. A card is
// sold or reloaded as a line on a sale at the register, paid like any sale
// (owner, 2026-11-11), so there's no Reload here.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import Link from "next/link";

interface GiftCardTransaction {
  id: number;
  transactionType: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reference: string | null;
  notes: string | null;
  created: string;
  createdBy: string | null;
}

interface GiftCard {
  id: number;
  barcode: string;
  externalCode: string | null;
  initialAmount: number;
  currentBalance: number;
  status: string;
  activatedAt: string | null;
  notes: string | null;
  /** The card this one's balance moved to, once it was retired. */
  replacedById: number | null;
  /** The card this one replaced, if it did. */
  replaces: { id: number } | null;
  transactions: GiftCardTransaction[];
}

// No Void, no Adjust and no Reload (owner, 2026-11-11): a balance changes only when money moves,
// and a card is retired by moving its balance to a new card.
type ModalType = "replace" | null;

const TX_TYPE_LABEL: Record<string, string> = {
  ISSUANCE: "Issuance",
  REDEMPTION: "Redemption",
  RELOAD: "Reload",
  ADJUSTMENT: "Adjustment",
  VOID: "Void",
  IMPORT: "Import",
  TRANSFER: "Moved",
  REFUND: "Refund",
};

const TX_TYPE_COLOR: Record<string, string> = {
  ISSUANCE: "text-green-700",
  REDEMPTION: "text-red-700",
  RELOAD: "text-green-700",
  ADJUSTMENT: "text-yellow-700",
  VOID: "text-red-700",
  IMPORT: "text-brand-gray",
  TRANSFER: "text-brand-blue",
  REFUND: "text-green-700",
};

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  REDEEMED: "bg-brand-gray/20 text-brand-gray",
  VOIDED: "bg-red-100 text-red-800",
  REPLACED: "bg-brand-gray/20 text-brand-gray",
};

export function GiftCardDetailView({ id }: { id: string }) {
  const router = useRouter();
  const formatMoney = useMoneyFormatter();
  const [card, setCard] = useState<GiftCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalType>(null);
  const [newBarcode, setNewBarcode] = useState("");
  const [saving, setSaving] = useState(false);

  const fetchCard = useCallback(async () => {
    try {
      const res = await fetch(`/api/gift-cards/${encodeURIComponent(id)}`);
      if (res.ok) {
        setCard(await res.json());
      } else {
        toast.error("Gift card not found");
        router.push("/app/admin/gift-cards");
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Failed to load gift card"));
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    fetchCard();
  }, [fetchCard]);

  const handleReplace = async () => {
    if (!newBarcode.trim()) {
      toast.error("Scan or type the new card's number");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/gift-cards/${encodeURIComponent(id)}/replace`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barcode: newBarcode }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        toast.success("Balance moved to the new card");
        setModal(null);
        setNewBarcode("");
        router.push(`/app/admin/gift-cards/${body.newCardId}`);
      } else {
        toast.error(getErrorMessage(body, "The balance wasn't moved"));
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "The balance wasn't moved"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-brand-gray font-serif">Loading...</p>;
  }

  if (!card) return null;

  return (
    <div className="font-serif">
      <button
        onClick={() => router.push("/app/admin/gift-cards")}
        className="flex items-center gap-1 text-brand-blue font-serif mb-4 hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Gift Cards
      </button>

      {/* Card summary */}
      <div className="bg-white border border-brand-gray/20 rounded-xl p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-brand-gray font-serif mb-1">Barcode</p>
            <p className="font-mono text-lg text-brand-black">{card.barcode}</p>
            {card.externalCode && (
              <p className="text-sm text-brand-gray font-serif mt-1">
                the POS: {card.externalCode}
              </p>
            )}
          </div>
          <span
            className={`px-3 py-1 rounded-full text-sm font-serif-condensed font-semibold ${
              STATUS_STYLES[card.status] ?? ""
            }`}
          >
            {card.status}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-6 mt-6">
          <div>
            <p className="text-sm text-brand-gray font-serif">Current Balance</p>
            <p className="text-3xl font-serif font-semibold text-brand-blue">
              {formatMoney(card.currentBalance)}
            </p>
          </div>
          <div>
            <p className="text-sm text-brand-gray font-serif">Initial Amount</p>
            <p className="text-lg font-serif text-brand-black">{formatMoney(card.initialAmount)}</p>
          </div>
          <div>
            <p className="text-sm text-brand-gray font-serif">Activated</p>
            <p className="text-lg font-serif text-brand-black">
              {card.activatedAt ? new Date(card.activatedAt).toLocaleDateString() : "-"}
            </p>
          </div>
        </div>

        {card.replacedById !== null && (
          <p className="mt-4 text-sm font-serif text-brand-gray">
            Its balance moved to{" "}
            <Link
              href={`/app/admin/gift-cards/${card.replacedById}`}
              className="text-brand-blue hover:underline"
            >
              card #{card.replacedById}
            </Link>
            .
          </p>
        )}
        {card.replaces && (
          <p className="mt-4 text-sm font-serif text-brand-gray">
            Replaces{" "}
            <Link
              href={`/app/admin/gift-cards/${card.replaces.id}`}
              className="text-brand-blue hover:underline"
            >
              card #{card.replaces.id}
            </Link>
            .
          </p>
        )}

        {card.status !== "VOIDED" && card.status !== "REPLACED" && (
          <div className="flex gap-2 mt-6">
            <Button variant="outline" onClick={() => setModal("replace")}>
              Move to a New Card
            </Button>
          </div>
        )}
      </div>

      {/* Transaction history */}
      <h3 className="text-lg font-serif font-semibold text-brand-blue mb-3">Transaction History</h3>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-brand-gray/30 text-left">
            <th className="py-2 px-3 font-serif font-semibold text-brand-blue text-sm">Date</th>
            <th className="py-2 px-3 font-serif font-semibold text-brand-blue text-sm">Type</th>
            <th className="py-2 px-3 font-serif font-semibold text-brand-blue text-sm text-right">
              Amount
            </th>
            <th className="py-2 px-3 font-serif font-semibold text-brand-blue text-sm text-right">
              Before
            </th>
            <th className="py-2 px-3 font-serif font-semibold text-brand-blue text-sm text-right">
              After
            </th>
            <th className="py-2 px-3 font-serif font-semibold text-brand-blue text-sm">
              Reference
            </th>
            <th className="py-2 px-3 font-serif font-semibold text-brand-blue text-sm">By</th>
          </tr>
        </thead>
        <tbody>
          {card.transactions.map((t, i) => (
            <tr
              key={t.id}
              className={`border-b border-brand-gray/10 ${i % 2 === 0 ? "bg-white" : "bg-brand-stripe"}`}
            >
              <td className="py-2 px-3 font-serif text-sm text-brand-black">
                {new Date(t.created).toLocaleDateString()}
              </td>
              <td
                className={`py-2 px-3 font-serif text-sm font-semibold ${
                  TX_TYPE_COLOR[t.transactionType] ?? ""
                }`}
              >
                {TX_TYPE_LABEL[t.transactionType] ?? t.transactionType}
              </td>
              <td className="py-2 px-3 font-serif text-sm text-brand-black text-right">
                {formatMoney(t.amount)}
              </td>
              <td className="py-2 px-3 font-serif text-sm text-brand-gray text-right">
                {formatMoney(t.balanceBefore)}
              </td>
              <td className="py-2 px-3 font-serif text-sm text-brand-black text-right font-semibold">
                {formatMoney(t.balanceAfter)}
              </td>
              <td className="py-2 px-3 font-serif text-sm text-brand-gray">{t.reference || "-"}</td>
              <td className="py-2 px-3 font-serif text-sm text-brand-gray">{t.createdBy || "-"}</td>
            </tr>
          ))}
          {card.transactions.length === 0 && (
            <tr>
              <td colSpan={7} className="py-4 text-center text-brand-gray font-serif">
                No transactions
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {modal === "replace" && (
        <Modal
          title="Move to a New Card"
          onClose={() => setModal(null)}
          onSave={handleReplace}
          saving={saving}
        >
          <p className="font-serif text-brand-black mb-2">
            The whole balance of{" "}
            <span className="font-semibold">{formatMoney(card.currentBalance)}</span> moves to the
            new card. This card stays on record at $0, with its history, and can&apos;t be used
            again.
          </p>
          <FormInput
            label="New card number"
            name="newBarcode"
            value={newBarcode}
            onChange={setNewBarcode}
            required
            placeholder="Scan the new card"
          />
        </Modal>
      )}
    </div>
  );
}
