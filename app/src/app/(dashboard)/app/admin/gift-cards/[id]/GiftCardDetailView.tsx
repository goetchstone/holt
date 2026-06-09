"use client";

// /app/src/app/(dashboard)/app/admin/gift-cards/[id]/GiftCardDetailView.tsx
//
// Gift Card detail body. App Router port of the legacy admin/gift-cards/[id]
// body (minus MainLayout chrome, which the (dashboard) layout supplies). Shows
// the card summary + transaction history and drives reload / adjust / void via
// the shared /api/gift-cards/[id]/* REST endpoints.

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";
import FormInput from "@/components/form/FormInput";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";

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
  transactions: GiftCardTransaction[];
}

type ModalType = "reload" | "adjust" | "void" | null;

const TX_TYPE_LABEL: Record<string, string> = {
  ISSUANCE: "Issuance",
  REDEMPTION: "Redemption",
  RELOAD: "Reload",
  ADJUSTMENT: "Adjustment",
  VOID: "Void",
  IMPORT: "Import",
};

const TX_TYPE_COLOR: Record<string, string> = {
  ISSUANCE: "text-green-700",
  REDEMPTION: "text-red-700",
  RELOAD: "text-green-700",
  ADJUSTMENT: "text-yellow-700",
  VOID: "text-red-700",
  IMPORT: "text-sh-gray",
};

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  REDEEMED: "bg-sh-gray/20 text-sh-gray",
  VOIDED: "bg-red-100 text-red-800",
};

export function GiftCardDetailView({ id }: { id: string }) {
  const router = useRouter();
  const formatMoney = useMoneyFormatter();
  const [card, setCard] = useState<GiftCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalType>(null);
  const [reloadAmount, setReloadAmount] = useState("");
  const [reloadRef, setReloadRef] = useState("");
  const [adjustBalance, setAdjustBalance] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
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

  const handleReload = async () => {
    const amount = Number.parseFloat(reloadAmount);
    if (!amount || amount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/gift-cards/${encodeURIComponent(id)}/reload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, reference: reloadRef || null }),
      });
      if (res.ok) {
        toast.success(`${formatMoney(amount)} added to card`);
        setModal(null);
        setReloadAmount("");
        setReloadRef("");
        fetchCard();
      } else {
        toast.error(getErrorMessage(await res.json().catch(() => null), "Failed to reload"));
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error reloading card"));
    } finally {
      setSaving(false);
    }
  };

  const handleAdjust = async () => {
    const newBal = Number.parseFloat(adjustBalance);
    if (Number.isNaN(newBal) || newBal < 0) {
      toast.error("Enter a valid balance");
      return;
    }
    if (!adjustReason.trim()) {
      toast.error("Reason is required");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/gift-cards/${encodeURIComponent(id)}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newBalance: newBal, reason: adjustReason }),
      });
      if (res.ok) {
        toast.success("Balance adjusted");
        setModal(null);
        setAdjustBalance("");
        setAdjustReason("");
        fetchCard();
      } else {
        toast.error(getErrorMessage(await res.json().catch(() => null), "Failed to adjust"));
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error adjusting balance"));
    } finally {
      setSaving(false);
    }
  };

  const handleVoid = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/gift-cards/${encodeURIComponent(id)}/void`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        toast.success("Card voided");
        setModal(null);
        fetchCard();
      } else {
        toast.error(getErrorMessage(await res.json().catch(() => null), "Failed to void"));
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error voiding card"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <p className="text-sh-gray font-serif">Loading...</p>;
  }

  if (!card) return null;

  return (
    <div className="font-serif">
      <button
        onClick={() => router.push("/app/admin/gift-cards")}
        className="flex items-center gap-1 text-sh-blue font-serif mb-4 hover:underline"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Gift Cards
      </button>

      {/* Card summary */}
      <div className="bg-white border border-sh-gray/20 rounded-xl p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-sh-gray font-serif mb-1">Barcode</p>
            <p className="font-mono text-lg text-sh-black">{card.barcode}</p>
            {card.externalCode && (
              <p className="text-sm text-sh-gray font-serif mt-1">the POS: {card.externalCode}</p>
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
            <p className="text-sm text-sh-gray font-serif">Current Balance</p>
            <p className="text-3xl font-serif font-semibold text-sh-blue">
              {formatMoney(card.currentBalance)}
            </p>
          </div>
          <div>
            <p className="text-sm text-sh-gray font-serif">Initial Amount</p>
            <p className="text-lg font-serif text-sh-black">{formatMoney(card.initialAmount)}</p>
          </div>
          <div>
            <p className="text-sm text-sh-gray font-serif">Activated</p>
            <p className="text-lg font-serif text-sh-black">
              {card.activatedAt ? new Date(card.activatedAt).toLocaleDateString() : "-"}
            </p>
          </div>
        </div>

        {card.status !== "VOIDED" && (
          <div className="flex gap-2 mt-6">
            <Button onClick={() => setModal("reload")}>Reload</Button>
            <Button variant="outline" onClick={() => setModal("adjust")}>
              Adjust Balance
            </Button>
            <Button
              variant="secondary"
              onClick={() => setModal("void")}
              className="!text-red-700 !border-red-300 hover:!bg-red-50"
            >
              Void Card
            </Button>
          </div>
        )}
      </div>

      {/* Transaction history */}
      <h3 className="text-lg font-serif font-semibold text-sh-blue mb-3">Transaction History</h3>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-sh-gray/30 text-left">
            <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm">Date</th>
            <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm">Type</th>
            <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm text-right">
              Amount
            </th>
            <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm text-right">
              Before
            </th>
            <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm text-right">
              After
            </th>
            <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm">Reference</th>
            <th className="py-2 px-3 font-serif font-semibold text-sh-blue text-sm">By</th>
          </tr>
        </thead>
        <tbody>
          {card.transactions.map((t, i) => (
            <tr
              key={t.id}
              className={`border-b border-sh-gray/10 ${i % 2 === 0 ? "bg-white" : "bg-sh-stripe"}`}
            >
              <td className="py-2 px-3 font-serif text-sm text-sh-black">
                {new Date(t.created).toLocaleDateString()}
              </td>
              <td
                className={`py-2 px-3 font-serif text-sm font-semibold ${
                  TX_TYPE_COLOR[t.transactionType] ?? ""
                }`}
              >
                {TX_TYPE_LABEL[t.transactionType] ?? t.transactionType}
              </td>
              <td className="py-2 px-3 font-serif text-sm text-sh-black text-right">
                {formatMoney(t.amount)}
              </td>
              <td className="py-2 px-3 font-serif text-sm text-sh-gray text-right">
                {formatMoney(t.balanceBefore)}
              </td>
              <td className="py-2 px-3 font-serif text-sm text-sh-black text-right font-semibold">
                {formatMoney(t.balanceAfter)}
              </td>
              <td className="py-2 px-3 font-serif text-sm text-sh-gray">{t.reference || "-"}</td>
              <td className="py-2 px-3 font-serif text-sm text-sh-gray">{t.createdBy || "-"}</td>
            </tr>
          ))}
          {card.transactions.length === 0 && (
            <tr>
              <td colSpan={7} className="py-4 text-center text-sh-gray font-serif">
                No transactions
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {modal === "reload" && (
        <Modal
          title="Reload Gift Card"
          onClose={() => setModal(null)}
          onSave={handleReload}
          saving={saving}
        >
          <FormInput
            label="Amount to Add"
            name="reloadAmount"
            value={reloadAmount}
            onChange={setReloadAmount}
            type="number"
            placeholder="25.00"
          />
          <FormInput
            label="Reference (optional)"
            name="reloadRef"
            value={reloadRef}
            onChange={setReloadRef}
            placeholder="Order number, reason, etc."
          />
        </Modal>
      )}

      {modal === "adjust" && (
        <Modal
          title="Adjust Balance"
          onClose={() => setModal(null)}
          onSave={handleAdjust}
          saving={saving}
        >
          <p className="text-sm text-sh-gray font-serif mb-2">
            Current balance:{" "}
            <span className="font-semibold">{formatMoney(card.currentBalance)}</span>
          </p>
          <FormInput
            label="New Balance"
            name="adjustBalance"
            value={adjustBalance}
            onChange={setAdjustBalance}
            type="number"
            placeholder="0.00"
          />
          <FormInput
            label="Reason"
            name="adjustReason"
            value={adjustReason}
            onChange={setAdjustReason}
            required
            placeholder="Manager correction, etc."
          />
        </Modal>
      )}

      {modal === "void" && (
        <Modal
          title="Void Gift Card"
          onClose={() => setModal(null)}
          onSave={handleVoid}
          saving={saving}
        >
          <p className="font-serif text-sh-black">
            This will permanently void this gift card and zero out the remaining balance of{" "}
            <span className="font-semibold">{formatMoney(card.currentBalance)}</span>.
          </p>
          <p className="font-serif text-red-700 text-sm mt-2">This action cannot be undone.</p>
        </Modal>
      )}
    </div>
  );
}
