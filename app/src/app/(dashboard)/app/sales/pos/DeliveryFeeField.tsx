"use client";

// GAP-09: the register's delivery fee. When the sale goes out by delivery it
// looks up the zone that delivers to the customer and fills in that zone's fee,
// which staff can change. Until staff change it, it follows the zone as the
// customer or the cart changes. The sale charges whatever this holds
// (create-from-cart.ts); the server never prices delivery behind the register's
// back.

import { useEffect, useState } from "react";
import axios from "axios";
import type { DeliveryFeeQuote } from "@/lib/delivery/deliveryFeeShared";

interface Props {
  customerId: number | null;
  pieces: number;
  /** The fee as typed, "" for none. */
  value: string;
  /** Whether staff typed the fee, rather than it following the zone. */
  edited: boolean;
  onChange: (value: string, edited: boolean) => void;
  fmt: (n: number) => string;
}

export function DeliveryFeeField({
  customerId,
  pieces,
  value,
  edited,
  onChange,
  fmt,
}: Readonly<Props>) {
  const [quote, setQuote] = useState<DeliveryFeeQuote | null>(null);
  const [lookupFailed, setLookupFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    axios
      .get<DeliveryFeeQuote>("/api/sales/delivery-fee-quote", {
        params: { customerId: customerId ?? "", pieces },
      })
      .then((res) => {
        if (cancelled) return;
        setQuote(res.data);
        setLookupFailed(false);
      })
      .catch(() => {
        if (!cancelled) setLookupFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId, pieces]);

  // Follow the zone until staff set a fee of their own.
  const zoneAmount = quote?.amount ?? null;
  useEffect(() => {
    if (edited || quote == null) return;
    onChange(zoneAmount == null ? "" : zoneAmount.toFixed(2), false);
  }, [edited, quote, zoneAmount, onChange]);

  return (
    <div className="mt-3 border-t border-brand-gray/10 pt-3">
      <label htmlFor="pos-delivery-fee" className="mb-1 block text-xs text-brand-gray">
        Delivery fee
      </label>
      <input
        id="pos-delivery-fee"
        type="number"
        step="0.01"
        min="0"
        value={value}
        onChange={(e) => onChange(e.target.value, true)}
        placeholder="0.00"
        className="w-32 rounded border border-brand-gray/30 px-2 py-1.5 text-sm"
      />
      <p className="mt-1 text-xs text-brand-gray">
        <QuoteNote quote={quote} lookupFailed={lookupFailed} customerId={customerId} fmt={fmt} />
        {edited && zoneAmount != null && value !== zoneAmount.toFixed(2) && (
          <button
            type="button"
            onClick={() => onChange(zoneAmount.toFixed(2), false)}
            className="ml-2 text-brand-blue underline"
          >
            Use the zone&apos;s fee
          </button>
        )}
      </p>
    </div>
  );
}

function QuoteNote({
  quote,
  lookupFailed,
  customerId,
  fmt,
}: Readonly<{
  quote: DeliveryFeeQuote | null;
  lookupFailed: boolean;
  customerId: number | null;
  fmt: (n: number) => string;
}>) {
  if (lookupFailed) return <>Couldn&apos;t look up the delivery zone. Enter the fee.</>;
  if (!quote) return <>Looking up the delivery zone…</>;
  if (quote.zone && quote.amount != null) {
    const pieces = `${quote.pieces} piece${quote.pieces === 1 ? "" : "s"}`;
    return (
      <>
        {quote.zone.name}, {pieces}: {fmt(quote.amount)}
      </>
    );
  }
  if (quote.zip) return <>No delivery zone covers ZIP {quote.zip}. Enter the fee.</>;
  if (customerId != null) return <>This customer has no address on file. Enter the fee.</>;
  return <>Add the customer to look up their delivery zone, or enter the fee.</>;
}
