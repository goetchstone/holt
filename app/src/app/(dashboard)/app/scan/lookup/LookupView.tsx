"use client";

// /app/src/app/(dashboard)/app/scan/lookup/LookupView.tsx
//
// Scan a product, a box, a rug or a place: what it is, and for a product
// every place it sits (free and committed), for a place everything in it.

import { useState } from "react";
import axios from "axios";
import { ScanFrame, type ScanMessage } from "@/components/scan/ScanFrame";
import { getErrorMessage } from "@/lib/toastError";
import type { ScanResult } from "@/lib/scan/resolveScan";
import type { StockLine } from "@/lib/scan/lookup";

export function LookupView() {
  const [message, setMessage] = useState<ScanMessage | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [stock, setStock] = useState<StockLine[]>([]);

  const onScan = async (code: string, storeLocationId: number | null) => {
    try {
      const res = await axios.get<{ result: ScanResult; stock: StockLine[] | null }>(
        "/api/scan/resolve",
        { params: { code, storeLocationId: storeLocationId ?? undefined, stock: 1 } },
      );
      setResult(res.data.result);
      setStock(res.data.stock ?? []);
      const r = res.data.result;
      setMessage(
        r.kind === "unknown"
          ? { tone: "error", text: r.message }
          : {
              tone: "ok",
              text:
                r.kind === "place"
                  ? `${r.place.path} (${r.place.storeName})`
                  : `${r.product.name}${r.box ? ` · box ${r.box.box} of ${r.box.of}` : ""}`,
            },
      );
    } catch (err) {
      setMessage({ tone: "error", text: getErrorMessage(err, "Could not look that up.") });
    }
  };

  const total = (key: "free" | "committed") => stock.reduce((s, l) => s + l[key], 0);

  return (
    <ScanFrame
      title="Look up"
      prompt="Scan a product, box or place"
      onScan={onScan}
      message={message}
    >
      {result?.kind === "product" && (
        <p className="text-sm text-brand-gray">
          {result.product.productNumber}
          {result.product.boxesPerUnit > 1
            ? ` · ${result.product.boxesPerUnit} boxes per unit`
            : ""}
          {` · ${total("free")} free, ${total("committed")} committed`}
        </p>
      )}
      {stock.length > 0 && (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-brand-gray border-b border-brand-gray/20">
              <th className="py-1 pr-2">{result?.kind === "place" ? "Product" : "Place"}</th>
              <th className="py-1 pr-2 text-right">Free</th>
              <th className="py-1 text-right">Sold</th>
            </tr>
          </thead>
          <tbody>
            {stock.map((l) => (
              <tr key={`${l.placeId}:${l.productId}`} className="border-b border-brand-gray/10">
                <td className="py-1 pr-2">
                  {result?.kind === "place" ? (
                    <>
                      {l.productName}
                      <span className="block text-xs text-brand-gray">{l.placePath}</span>
                    </>
                  ) : (
                    <>
                      {l.placePath}
                      <span className="block text-xs text-brand-gray">{l.storeName}</span>
                    </>
                  )}
                </td>
                <td className="py-1 pr-2 text-right">{l.free || ""}</td>
                <td className="py-1 text-right">{l.committed || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result && result.kind !== "unknown" && stock.length === 0 && (
        <p className="text-sm text-brand-gray">Nothing in stock here.</p>
      )}
    </ScanFrame>
  );
}
