"use client";

// /app/src/app/(dashboard)/app/inventory/sales/TagsToChangePanel.tsx
//
// Tags to change today (GAP-06 part B), on the store's day: products in a sale
// that starts today need a SALE tag; products whose sale ended yesterday, or was
// ended early since, need their regular PRODUCT tag back
// (GET /api/pricing/sales/tags-to-change). "Print all" sends them through
// POST /api/print-label/batch with that kind and the chosen store, in requests of
// the route's size (lib/labels/batchPrintShared.ts), under the batch route's own
// permission and rate limit. A tag that can't print says why (rule 11). Nothing
// prints these on a schedule.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Printer, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale, useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { plural } from "@/components/pricing/ProductPicker";
import { getErrorMessage } from "@/lib/toastError";
import { inBatches } from "@/lib/labels/batchPrintShared";
import { saleDayText, type TagToChange, type TagsToChange } from "@/lib/pricing/salesShared";

type TagKind = "SALE" | "PRODUCT";

interface PrintResult {
  productId: number;
  success: boolean;
  error?: string;
}

interface Failure {
  productNumber: string;
  error: string;
}

function TagList({
  title,
  explain,
  kind,
  rows,
  printing,
  onPrint,
}: Readonly<{
  title: string;
  explain: string;
  kind: TagKind;
  rows: TagToChange[];
  printing: TagKind | null;
  onPrint: (kind: TagKind, rows: TagToChange[]) => void;
}>) {
  const fmt = useMoneyFormatter();
  const { locale } = useLocale();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold text-brand-blue">
          {title} ({rows.length.toLocaleString()})
        </h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPrint(kind, rows)}
          disabled={rows.length === 0 || printing !== null}
        >
          <Printer className="mr-2 h-4 w-4" aria-hidden />
          {printing === kind ? "Printing…" : `Print all ${plural(rows.length, "tag")}`}
        </Button>
      </div>
      <p className="text-xs text-brand-gray">{explain}</p>
      {rows.length > 0 && (
        <div className="max-h-[260px] overflow-auto border border-brand-gray/20 rounded">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-brand-gray/20 text-left text-xs text-brand-gray uppercase tracking-wide">
                <th className="px-3 py-2">Part #</th>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Sale</th>
                <th className="px-3 py-2 text-right">Price today</th>
                {kind === "SALE" && <th className="px-3 py-2 text-right">Was</th>}
                {kind === "SALE" && <th className="px-3 py-2">Ends</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.productId} className="border-b border-brand-gray/10">
                  <td className="px-3 py-2 font-mono text-xs">{r.productNumber}</td>
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-brand-gray">{r.saleName}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.price === null ? "none" : fmt(r.price)}
                  </td>
                  {kind === "SALE" && (
                    <td className="px-3 py-2 text-right tabular-nums text-brand-gray line-through">
                      {r.regularPrice === null ? "" : fmt(r.regularPrice)}
                    </td>
                  )}
                  {kind === "SALE" && (
                    <td className="px-3 py-2 whitespace-nowrap">
                      {saleDayText(r.saleEndsOn, locale)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function TagsToChangePanel() {
  const { locale } = useLocale();
  const [tags, setTags] = useState<TagsToChange | null>(null);
  const [stores, setStores] = useState<{ id: number; name: string }[]>([]);
  const [storeId, setStoreId] = useState("");
  const [printing, setPrinting] = useState<TagKind | null>(null);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    axios
      .get<TagsToChange>("/api/pricing/sales/tags-to-change")
      .then((res) => {
        if (live) setTags(res.data);
      })
      .catch((err) => {
        if (live) toast.error(getErrorMessage(err, "Couldn't work out which tags change today."));
      });
    return () => {
      live = false;
    };
  }, [tick]);

  useEffect(() => {
    axios
      .get<{ locations: { id: number; name: string }[] }>("/api/store-locations", {
        params: { isActive: true },
      })
      .then((res) => setStores(res.data.locations ?? []))
      .catch((err) => toast.error(getErrorMessage(err, "Couldn't load the stores.")));
  }, []);

  const print = useCallback(
    async (kind: TagKind, rows: TagToChange[]) => {
      setPrinting(kind);
      setFailures([]);
      const numberOf = new Map(rows.map((r) => [r.productId, r.productNumber]));
      const failed: Failure[] = [];
      let printed = 0;
      try {
        for (const batch of inBatches(rows.map((r) => r.productId))) {
          const res = await axios.post<{ results: PrintResult[] }>("/api/print-label/batch", {
            items: batch.map((productId) => ({ productId })),
            kind,
            storeLocationId: storeId ? Number(storeId) : null,
          });
          for (const r of res.data.results ?? []) {
            if (r.success) printed += 1;
            else
              failed.push({
                productNumber: numberOf.get(r.productId) ?? String(r.productId),
                error: r.error ?? "Print failed",
              });
          }
        }
      } catch (err) {
        // A refused request stops the run; what printed before it stays printed.
        toast.error(
          getErrorMessage(err, "The tags stopped printing.") +
            (printed > 0 ? ` ${plural(printed, "tag")} printed before it stopped.` : ""),
        );
        setFailures(failed);
        setPrinting(null);
        return;
      }
      setFailures(failed);
      setPrinting(null);
      if (failed.length > 0) toast.error(`${plural(failed.length, "tag")} didn't print.`);
      else toast.success(`${plural(printed, "tag")} sent to the printer.`);
    },
    [storeId],
  );

  return (
    <div className="bg-white border border-brand-gray/20 rounded-lg p-4 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-lg font-semibold text-brand-blue">Tags to change today</h2>
          {tags && (
            <p className="text-xs text-brand-gray">
              {saleDayText(tags.today, locale)}, the store&apos;s day.
            </p>
          )}
        </div>
        <div className="ml-auto">
          <label htmlFor="tags-store" className="block text-xs text-brand-gray mb-1">
            Print at
          </label>
          <select
            id="tags-store"
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            className="min-h-[40px] border border-brand-gray/30 rounded px-3 text-sm bg-white"
          >
            <option value="">Any printer loaded for it</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="outline"
          onClick={() => setTick((n) => n + 1)}
          disabled={printing !== null}
          className="min-h-[40px]"
          aria-label="Check again"
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {tags ? (
        <div className="space-y-6">
          <TagList
            title="Sale tags"
            explain="In a sale that starts today: put the sale tag on, with the regular price as the was price."
            kind="SALE"
            rows={tags.saleTags}
            printing={printing}
            onPrint={print}
          />
          <TagList
            title="Regular tags"
            explain="Their sale ended yesterday or was ended early since, and they aren't on sale today: back to the regular tag."
            kind="PRODUCT"
            rows={tags.productTags}
            printing={printing}
            onPrint={print}
          />
        </div>
      ) : (
        <p className="text-sm text-brand-gray">Loading…</p>
      )}

      {failures.length > 0 && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm">
          <p className="font-semibold text-red-900">These tags didn&apos;t print:</p>
          <ul className="mt-1 list-disc pl-5 text-red-900">
            {failures.map((f) => (
              <li key={f.productNumber}>
                {f.productNumber}: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
