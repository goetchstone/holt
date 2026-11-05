"use client";

// /app/src/app/(dashboard)/app/inventory/products/[id]/ProductTagsSection.tsx
//
// Print this product's tags, and set what its sale and law tags need (GAP-18,
// lib/labels/productTag.ts). A sale tag's price is the product's retail, which is
// what the register charges; its was price is set here. The route says what's
// missing if a tag can't print (rule 11).

import { useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { LABEL_CONTEXT_NAMES } from "@/lib/labels/renderTemplate";
import { getErrorMessage } from "@/lib/toastError";

const KINDS = ["PRODUCT", "SALE", "LAW"] as const;
const MAX_COPIES = 10;

export function ProductTagsSection({
  productId,
  wasPrice,
  lawTagText,
  canEdit,
  canPrint,
  onChanged,
}: Readonly<{
  productId: number;
  wasPrice: number | null;
  lawTagText: string | null;
  canEdit: boolean;
  canPrint: boolean;
  onChanged: () => void;
}>) {
  const [kind, setKind] = useState<(typeof KINDS)[number]>("PRODUCT");
  const [copies, setCopies] = useState(1);
  const [storeId, setStoreId] = useState("");
  const [stores, setStores] = useState<{ id: number; name: string }[]>([]);
  const [was, setWas] = useState(wasPrice?.toString() ?? "");
  const [lawText, setLawText] = useState(lawTagText ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!canPrint) return;
    axios
      .get("/api/store-locations", { params: { isActive: true } })
      .then((res) => setStores(res.data.locations ?? res.data))
      .catch((err) => toast.error(getErrorMessage(err, "Couldn't load the stores.")));
  }, [canPrint]);

  if (!canEdit && !canPrint) return null;

  const print = async () => {
    setBusy(true);
    try {
      const res = await axios.post("/api/print-label", {
        productId,
        kind,
        copies,
        storeLocationId: storeId ? Number(storeId) : null,
      });
      toast.success(res.data.message);
    } catch (err) {
      toast.error(getErrorMessage(err, "The tag did not print."));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      await axios.patch(`/api/products/${productId}`, { wasPrice: was, lawTagText: lawText });
      toast.success("Saved.");
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, "That wasn't saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md mb-6 space-y-4">
      <h2 className="text-lg font-semibold text-brand-navy">Tags</h2>
      {canPrint && (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="tag-kind" className="block text-xs text-brand-gray mb-1">
              Tag
            </label>
            <select
              id="tag-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
              className="min-h-[44px] border border-brand-gray/30 rounded px-3 text-sm"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {LABEL_CONTEXT_NAMES[k]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="tag-copies" className="block text-xs text-brand-gray mb-1">
              Copies
            </label>
            <input
              id="tag-copies"
              type="number"
              min={1}
              max={MAX_COPIES}
              value={copies}
              onChange={(e) => setCopies(Number(e.target.value))}
              className="min-h-[44px] w-20 border border-brand-gray/30 rounded px-3 text-sm"
            />
          </div>
          <div>
            <label htmlFor="tag-store" className="block text-xs text-brand-gray mb-1">
              Print at
            </label>
            <select
              id="tag-store"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              className="min-h-[44px] border border-brand-gray/30 rounded px-3 text-sm"
            >
              <option value="">Any printer loaded for it</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={print} disabled={busy}>
            Print
          </Button>
        </div>
      )}
      {canEdit && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="tag-was-price" className="block text-xs text-brand-gray mb-1">
              Was price, for a sale tag. The sale price is the retail price, which is what the
              register charges.
            </label>
            <input
              id="tag-was-price"
              type="number"
              min={0}
              step="0.01"
              value={was}
              onChange={(e) => setWas(e.target.value)}
              className="min-h-[44px] w-full border border-brand-gray/30 rounded px-3 text-sm"
            />
          </div>
          <div>
            <label htmlFor="tag-law-text" className="block text-xs text-brand-gray mb-1">
              Law tag wording for this product, such as what it&apos;s made of. The rest of the tag
              is your template.
            </label>
            <textarea
              id="tag-law-text"
              rows={3}
              maxLength={1000}
              value={lawText}
              onChange={(e) => setLawText(e.target.value)}
              className="w-full border border-brand-gray/30 rounded px-3 py-2 text-sm"
            />
          </div>
          <div>
            <Button variant="outline" onClick={save} disabled={busy}>
              Save
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
