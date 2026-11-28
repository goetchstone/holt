"use client";

// /app/src/app/(dashboard)/app/sales/pos/RegisterLookup.tsx
//
// Look something up without leaving the register: a sale already written (to
// take a payment on it, or open it), and a gift card (what is left on it).
//
// Owner, 2026-11-28, on the first card reader test: "I should also be able to
// look up sales from the pos", and gift cards with them. Until then a sale was
// found in the orders list, and a card's balance showed only while paying with
// it. Both read routes the cashier already has: the orders list ("View
// orders") and the gift card lookup ("Operate register"). Someone without
// "View orders" is offered the gift card check alone.
//
// Each search runs when asked for (Find, Check, or Enter), not as you type.

import { useState, type FormEvent } from "react";
import Link from "next/link";
import axios from "axios";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import {
  SALE_SEARCH_MIN,
  giftCardLine,
  lookupLabel,
  saleMoneyLine,
  saleTakesPayment,
  type FoundGiftCard,
  type FoundSale,
} from "@/lib/pos/registerLookupShared";

const inputClass =
  "w-full border border-brand-gray/30 rounded px-3 py-2 text-sm focus:outline-none focus:border-brand-blue";

export function RegisterLookup({
  canFindSales,
  canTakePayments,
  fmt,
  onTakePayment,
}: Readonly<{
  /** The sale search is offered: the viewer may read the orders list. */
  canFindSales: boolean;
  /** "Take payment" is offered on a sale that owes something. */
  canTakePayments: boolean;
  fmt: (n: number) => string;
  /** Open the payment screen on this sale. */
  onTakePayment: (saleId: number) => void;
}>) {
  const [open, setOpen] = useState(false);
  const [saleQuery, setSaleQuery] = useState("");
  const [sales, setSales] = useState<FoundSale[] | null>(null);
  const [saleNote, setSaleNote] = useState<string | null>(null);
  const [cardNumber, setCardNumber] = useState("");
  const [card, setCard] = useState<FoundGiftCard | null>(null);
  const [cardNote, setCardNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const findSales = async (event: FormEvent) => {
    event.preventDefault();
    const search = saleQuery.trim();
    if (search.length < SALE_SEARCH_MIN) {
      setSales(null);
      setSaleNote("Type an order number or a customer's name.");
      return;
    }
    setBusy(true);
    try {
      const res = await axios.get<{ orders: FoundSale[] }>("/api/sales/orders", {
        params: { search, limit: 8 },
      });
      setSales(res.data.orders);
      setSaleNote(res.data.orders.length === 0 ? `No sale matches "${search}".` : null);
    } catch (err) {
      setSales(null);
      setSaleNote(getErrorMessage(err, "The sales could not be searched."));
    } finally {
      setBusy(false);
    }
  };

  const checkCard = async (event: FormEvent) => {
    event.preventDefault();
    const barcode = cardNumber.trim();
    if (!barcode) {
      setCard(null);
      setCardNote("Scan or type the card's number.");
      return;
    }
    setBusy(true);
    try {
      const res = await axios.get<FoundGiftCard>("/api/gift-cards/lookup", {
        params: { barcode },
      });
      setCard(res.data);
      setCardNote(null);
    } catch (err) {
      setCard(null);
      setCardNote(getErrorMessage(err, "The gift card could not be looked up."));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="mb-4 text-right">
        <button
          onClick={() => setOpen(true)}
          className="text-sm text-brand-blue underline min-h-[44px]"
        >
          {lookupLabel(canFindSales)}
        </button>
      </div>
    );
  }

  return (
    <section
      aria-label={lookupLabel(canFindSales)}
      className="bg-white border border-brand-gray/20 rounded-lg shadow-sm p-4 mb-4 space-y-4"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-brand-blue">Look up</h2>
        <button onClick={() => setOpen(false)} className="text-sm text-brand-gray underline">
          Close
        </button>
      </div>

      {canFindSales && (
        <form onSubmit={findSales} className="space-y-2">
          <label htmlFor="pos-find-sale" className="block text-xs text-brand-gray">
            A sale: order number or customer name
          </label>
          <div className="flex gap-2">
            <input
              id="pos-find-sale"
              value={saleQuery}
              onChange={(e) => setSaleQuery(e.target.value)}
              placeholder="SO-1042, or Ana Reyes"
              className={inputClass}
            />
            <Button type="submit" variant="secondary" disabled={busy}>
              Find
            </Button>
          </div>
          {saleNote && <p className="text-sm text-brand-gray">{saleNote}</p>}
          {sales && sales.length > 0 && (
            <ul className="divide-y divide-brand-gray/10 border border-brand-gray/20 rounded">
              {sales.map((sale) => (
                <li key={sale.id} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium text-brand-black truncate">
                      {sale.orderno}
                      {sale.customerName ? ` · ${sale.customerName}` : ""}
                    </p>
                    <p className="text-xs text-brand-gray">
                      {sale.orderDate ? `${format(new Date(sale.orderDate), "PP")} · ` : ""}
                      {saleMoneyLine(sale, fmt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Link
                      href={`/app/sales/orders/${sale.id}`}
                      className="text-sm text-brand-blue underline"
                    >
                      Open
                    </Link>
                    {canTakePayments && saleTakesPayment(sale) && (
                      <Button size="sm" onClick={() => onTakePayment(sale.id)}>
                        Take payment
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}

      <form onSubmit={checkCard} className="space-y-2">
        <label htmlFor="pos-check-card" className="block text-xs text-brand-gray">
          A gift card: its number
        </label>
        <div className="flex gap-2">
          <input
            id="pos-check-card"
            value={cardNumber}
            onChange={(e) => setCardNumber(e.target.value)}
            placeholder="Scan or type the card"
            className={inputClass}
          />
          <Button type="submit" variant="secondary" disabled={busy}>
            Check
          </Button>
        </div>
        {cardNote && <p className="text-sm text-brand-gray">{cardNote}</p>}
        {card && <p className="text-sm font-medium text-brand-black">{giftCardLine(card, fmt)}</p>}
      </form>
    </section>
  );
}
