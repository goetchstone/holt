"use client";

// /app/src/app/(dashboard)/app/purchasing/orders/PurchaseOrderEditor.tsx
//
// GAP-01: write a stock purchase order by hand, or change one -- its vendor
// (new POs only), where it ships, when it's expected, notes, and lines picked
// from the vendor's products. Saves through POST /api/purchasing/orders or
// PUT /api/purchasing/orders/[id]/edit; the rules both sides check live in
// lib/purchasing/purchaseOrderShared.ts. Cost columns show only for a holder of
// "View cost"; without it a new line takes the catalog's cost on the server.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { CostHiddenNote } from "@/components/ui/CostHiddenNote";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { useDebounce } from "@/hooks/useDebounce";
import { getErrorMessage } from "@/lib/toastError";
import { expectedArrival } from "@/lib/vendorLeadTime";
import { MAX_PO_NOTES, poLineTotal, type PoLineInput } from "@/lib/purchasing/purchaseOrderShared";
import type { PoEditorState } from "@/lib/purchasing/stockPurchaseOrder";

interface VendorOption {
  id: number;
  name: string;
  leadTimeDays: number | null;
}

interface StoreOption {
  id: number;
  name: string;
}

interface ProductHit {
  id: number;
  productNumber: string;
  name: string;
  baseCost?: number | null;
}

interface EditorLine {
  key: string;
  id?: number;
  productId: number | null;
  partNo: string;
  productName: string;
  quantity: string;
  unitCost: string;
  linked: boolean;
}

export interface PurchaseOrderEditorProps {
  /** Every vendor, for a new PO; an existing PO keeps its vendor. */
  vendors: VendorOption[];
  stores: StoreOption[];
  costVisible: boolean;
  /** The PO being changed; absent for a new one. */
  po?: PoEditorState;
}

const INPUT = "w-full border border-brand-gray/30 rounded px-3 py-2 text-sm";

let nextKey = 0;
const newKey = () => `line-${++nextKey}`;

const ymd = (d: Date | null): string => (d ? d.toISOString().slice(0, 10) : "");

function fromPo(po: PoEditorState): EditorLine[] {
  return po.lines.map((l) => ({
    key: newKey(),
    id: l.id,
    productId: l.productId,
    partNo: l.partNo,
    productName: l.productName,
    quantity: String(l.quantity),
    unitCost: l.unitCost === null ? "" : String(l.unitCost),
    linked: l.linked,
  }));
}

/** The lines as the server reads them. Cost goes only when it was shown. */
function toInput(lines: EditorLine[], costVisible: boolean): PoLineInput[] {
  return lines.map((l) => ({
    ...(l.id === undefined ? {} : { id: l.id }),
    productId: l.productId ?? 0,
    quantity: Number(l.quantity),
    ...(costVisible && l.unitCost.trim() !== "" ? { unitCost: Number(l.unitCost) } : {}),
  }));
}

function ProductPicker({
  vendorId,
  costVisible,
  onPick,
}: {
  vendorId: number;
  costVisible: boolean;
  onPick: (p: ProductHit) => void;
}) {
  const formatCurrency = useMoneyFormatter();
  const [query, setQuery] = useState("");
  const debounced = useDebounce(query, 250);
  // The answer and the search it answers: still loading while they differ.
  const asked = `${vendorId}|${debounced}`;
  const [answer, setAnswer] = useState<{ asked: string; hits: ProductHit[] }>({
    asked: "",
    hits: [],
  });
  const loading = answer.asked !== asked;
  const hits = answer.hits;

  useEffect(() => {
    let live = true;
    axios
      .get("/api/purchasing/vendor-products", { params: { vendorId, search: debounced } })
      .then((res) => live && setAnswer({ asked, hits: res.data.products ?? [] }))
      .catch((err) => {
        if (!live) return;
        toast.error(getErrorMessage(err, "Couldn't search products."));
        setAnswer({ asked, hits: [] });
      });
    return () => {
      live = false;
    };
  }, [vendorId, debounced, asked]);

  return (
    <div className="mt-4">
      <label className="block text-sm text-brand-gray mb-1" htmlFor="po-product-search">
        Add a product
      </label>
      <input
        id="po-product-search"
        className={INPUT}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search this vendor's products by name, number or UPC"
      />
      <ul className="mt-1 max-h-56 overflow-y-auto border border-brand-gray/20 rounded divide-y divide-brand-gray/10">
        {hits.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-brand-linen flex justify-between gap-4"
              onClick={() => onPick(p)}
            >
              <span>
                <span className="text-brand-gray mr-2">{p.productNumber}</span>
                {p.name}
              </span>
              {costVisible && p.baseCost != null && (
                <span className="text-brand-gray">{formatCurrency(p.baseCost)}</span>
              )}
            </button>
          </li>
        ))}
        {!loading && hits.length === 0 && (
          <li className="px-3 py-2 text-sm text-brand-gray">
            No matching products from this vendor.
          </li>
        )}
      </ul>
    </div>
  );
}

function LinesTable({
  lines,
  costVisible,
  onChange,
  onRemove,
}: {
  lines: EditorLine[];
  costVisible: boolean;
  onChange: (key: string, patch: Partial<EditorLine>) => void;
  onRemove: (key: string) => void;
}) {
  const formatCurrency = useMoneyFormatter();
  if (lines.length === 0) {
    return <p className="text-sm text-brand-gray">No lines yet. Add a product below.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="bg-brand-linen text-brand-black">
          <tr>
            <th className="p-2 border-b">Part #</th>
            <th className="p-2 border-b">Product</th>
            <th className="p-2 border-b w-24">Qty</th>
            {costVisible && (
              <>
                <th className="p-2 border-b w-32">Unit cost</th>
                <th className="p-2 border-b text-right">Total</th>
              </>
            )}
            <th className="p-2 border-b" />
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.key} className="odd:bg-white even:bg-brand-stripe align-top">
              <td className="p-2 border-b">{l.partNo || "--"}</td>
              <td className="p-2 border-b">
                {l.productName || "--"}
                {l.productId === null && (
                  <p className="text-xs text-red-700">Not in the catalog: remove this line.</p>
                )}
                {l.linked && <p className="text-xs text-brand-gray">For a customer&apos;s order</p>}
              </td>
              <td className="p-2 border-b">
                <input
                  aria-label={`Quantity of ${l.productName}`}
                  type="number"
                  min="0"
                  step="any"
                  className={INPUT}
                  value={l.quantity}
                  disabled={l.linked}
                  onChange={(e) => onChange(l.key, { quantity: e.target.value })}
                />
              </td>
              {costVisible && (
                <>
                  <td className="p-2 border-b">
                    <input
                      aria-label={`Unit cost of ${l.productName}`}
                      type="number"
                      min="0"
                      step="0.01"
                      className={INPUT}
                      value={l.unitCost}
                      onChange={(e) => onChange(l.key, { unitCost: e.target.value })}
                    />
                  </td>
                  <td className="p-2 border-b text-right whitespace-nowrap">
                    {formatCurrency(poLineTotal(Number(l.quantity) || 0, Number(l.unitCost) || 0))}
                  </td>
                </>
              )}
              <td className="p-2 border-b">
                <button
                  type="button"
                  className="text-sm text-red-700 hover:underline disabled:text-brand-gray disabled:no-underline"
                  disabled={l.linked}
                  onClick={() => onRemove(l.key)}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PurchaseOrderEditor({
  vendors,
  stores,
  costVisible,
  po,
}: PurchaseOrderEditorProps) {
  const router = useRouter();
  const formatCurrency = useMoneyFormatter();
  const [vendorId, setVendorId] = useState<number | null>(po?.vendor.id ?? null);
  const [shipTo, setShipTo] = useState<number | null>(
    po?.shipToLocationId ?? (stores.length === 1 ? stores[0].id : null),
  );
  const [expected, setExpected] = useState(po?.expectedDelivery ?? "");
  const [notes, setNotes] = useState(po?.notes ?? "");
  const [lines, setLines] = useState<EditorLine[]>(() => (po ? fromPo(po) : []));
  const [saving, setSaving] = useState(false);

  const total = useMemo(
    () =>
      lines.reduce(
        (sum, l) => sum + poLineTotal(Number(l.quantity) || 0, Number(l.unitCost) || 0),
        0,
      ),
    [lines],
  );

  const chooseVendor = (id: number | null) => {
    if (lines.length > 0 && !confirm("Changing the vendor removes the lines you've added.")) return;
    setVendorId(id);
    setLines([]);
    const vendor = vendors.find((v) => v.id === id);
    setExpected(ymd(expectedArrival(new Date(), vendor?.leadTimeDays)));
  };

  const addProduct = (p: ProductHit) =>
    setLines((ls) => [
      ...ls,
      {
        key: newKey(),
        productId: p.id,
        partNo: p.productNumber,
        productName: p.name,
        quantity: "1",
        unitCost: p.baseCost == null ? "" : String(p.baseCost),
        linked: false,
      },
    ]);

  const saveLabel = po ? "Save changes" : "Create draft";

  const save = async () => {
    if (!vendorId) {
      toast.error("Choose a vendor.");
      return;
    }
    setSaving(true);
    const body = {
      shipToLocationId: shipTo,
      expectedDelivery: expected || null,
      notes: notes || null,
      lines: toInput(lines, costVisible),
    };
    try {
      if (po) {
        await axios.put(`/api/purchasing/orders/${po.id}/edit`, body);
        toast.success(`${po.poNumber} saved.`);
        router.push(`/app/purchasing/orders/${po.id}`);
      } else {
        const res = await axios.post("/api/purchasing/orders", { ...body, vendorId });
        toast.success(`${res.data.poNumber} created as a draft.`);
        router.push(`/app/purchasing/orders/${res.data.id}`);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't save the purchase order."));
      setSaving(false);
    }
  };

  if (po?.editProblem) {
    return (
      <div className="max-w-4xl mx-auto mt-8 font-serif">
        <h1 className="text-2xl font-semibold text-brand-blue mb-4">PO {po.poNumber}</h1>
        <p className="mb-4">{po.editProblem}</p>
        <Link href={`/app/purchasing/orders/${po.id}`}>
          <Button variant="secondary">Back to the purchase order</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto mt-8 font-serif">
      <h1 className="text-2xl font-semibold text-brand-blue mb-6">
        {po ? `Edit PO ${po.poNumber}` : "New purchase order"}
      </h1>

      <div className="bg-white p-6 rounded-lg shadow-md mb-6 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div>
          <label className="block text-brand-gray mb-1" htmlFor="po-vendor">
            Vendor
          </label>
          {po ? (
            <p id="po-vendor" className="py-2">
              {po.vendor.name}
            </p>
          ) : (
            <select
              id="po-vendor"
              className={INPUT}
              value={vendorId ?? ""}
              onChange={(e) => chooseVendor(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Choose a vendor</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className="block text-brand-gray mb-1" htmlFor="po-ship-to">
            Ship to
          </label>
          <select
            id="po-ship-to"
            className={INPUT}
            value={shipTo ?? ""}
            onChange={(e) => setShipTo(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">Choose where it&apos;s delivered</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-brand-gray mb-1" htmlFor="po-expected">
            Expected delivery
          </label>
          <input
            id="po-expected"
            type="date"
            className={INPUT}
            value={expected}
            onChange={(e) => setExpected(e.target.value)}
          />
          <p className="text-xs text-brand-gray mt-1">
            Starts from the vendor&apos;s lead time; leave empty when it isn&apos;t known.
          </p>
        </div>
        <div>
          <label className="block text-brand-gray mb-1" htmlFor="po-notes">
            Notes for the vendor
          </label>
          <textarea
            id="po-notes"
            className={INPUT}
            rows={3}
            maxLength={MAX_PO_NOTES}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      <div className="bg-white p-6 rounded-lg shadow-md mb-6">
        <h2 className="text-xl font-semibold mb-3">Lines</h2>
        <LinesTable
          lines={lines}
          costVisible={costVisible}
          onChange={(key, patch) =>
            setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
          }
          onRemove={(key) => setLines((ls) => ls.filter((l) => l.key !== key))}
        />
        {costVisible && lines.length > 0 && (
          <p className="text-right font-semibold mt-3">Total {formatCurrency(total)}</p>
        )}
        {!costVisible && <CostHiddenNote className="mt-2" />}
        {vendorId ? (
          <ProductPicker vendorId={vendorId} costVisible={costVisible} onPick={addProduct} />
        ) : (
          <p className="text-sm text-brand-gray mt-4">Choose a vendor to add its products.</p>
        )}
      </div>

      <div className="flex gap-2 justify-end mb-10">
        <Link href={po ? `/app/purchasing/orders/${po.id}` : "/app/purchasing/orders"}>
          <Button variant="secondary">Cancel</Button>
        </Link>
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving..." : saveLabel}
        </Button>
      </div>
    </div>
  );
}
