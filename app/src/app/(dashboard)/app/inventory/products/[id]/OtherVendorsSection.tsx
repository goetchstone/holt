"use client";

// /app/src/app/(dashboard)/app/inventory/products/[id]/OtherVendorsSection.tsx
//
// GAP-22: the other vendors an item can be bought from, on the product screen
// (docs/DECISIONS.md 31). A purchase order to any of them may order the item,
// under that vendor's item number and at its cost. The item's own vendor, set
// in Edit, stays the one for pricing and reports. Reads and writes
// /api/products/[id]/sources; cost shows only for a holder of View cost.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import { getErrorMessage } from "@/lib/toastError";
import {
  ITEM_NUMBER_MAX,
  type ProductSourceRow,
  type ProductSourcesResponse,
} from "@/lib/purchasing/productSourcesShared";

const INPUT = "w-full border border-brand-gray/30 rounded px-3 py-2 text-sm";

interface VendorOption {
  id: number;
  name: string;
}

interface Draft {
  itemNumber: string;
  cost: string;
}

const EMPTY: Draft = { itemNumber: "", cost: "" };

/** The body a draft saves: cost only when the viewer sees it, blank as null. */
function bodyOf(draft: Draft, costVisible: boolean): Record<string, unknown> {
  return {
    itemNumber: draft.itemNumber.trim() || null,
    ...(costVisible ? { cost: draft.cost.trim() === "" ? null : Number(draft.cost) } : {}),
  };
}

export function OtherVendorsSection({
  productId,
  ownVendorId,
  canEdit,
}: {
  productId: number;
  ownVendorId: number | undefined;
  canEdit: boolean;
}) {
  const fmt = useMoneyFormatter();
  const [data, setData] = useState<ProductSourcesResponse | null>(null);
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [newVendorId, setNewVendorId] = useState("");
  const [newDraft, setNewDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<{ id: number; draft: Draft } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    () =>
      axios
        .get<ProductSourcesResponse>(`/api/products/${productId}/sources`)
        .then((res) => setData(res.data))
        .catch((err: unknown) =>
          toast.error(getErrorMessage(err, "Couldn't load the item's other vendors.")),
        ),
    [productId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canEdit) return;
    axios
      .get<VendorOption[]>("/api/vendors/vendor-list")
      .then((res) => setVendors(Array.isArray(res.data) ? res.data : []))
      .catch((err: unknown) => toast.error(getErrorMessage(err, "Couldn't load vendors.")));
  }, [canEdit]);

  if (!data) return null;
  const { costVisible, sources } = data;
  if (sources.length === 0 && !canEdit) return null;

  const listed = new Set(sources.map((s) => s.vendorId));
  const offered = vendors.filter((v) => v.id !== ownVendorId && !listed.has(v.id));

  const run = async (act: () => Promise<unknown>, done: string, fallback: string) => {
    setBusy(true);
    try {
      await act();
      toast.success(done);
      await load();
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err, fallback));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const ok = await run(
      () =>
        axios.post(`/api/products/${productId}/sources`, {
          vendorId: Number(newVendorId),
          ...bodyOf(newDraft, costVisible),
        }),
      "Vendor added.",
      "Couldn't add the vendor.",
    );
    if (ok) {
      setNewVendorId("");
      setNewDraft(EMPTY);
    }
  };

  const save = async () => {
    if (!editing) return;
    const ok = await run(
      () =>
        axios.patch(
          `/api/products/${productId}/sources/${editing.id}`,
          bodyOf(editing.draft, costVisible),
        ),
      "Vendor saved.",
      "Couldn't save the vendor.",
    );
    if (ok) setEditing(null);
  };

  const remove = async (s: ProductSourceRow) => {
    if (!globalThis.confirm(`Stop buying this item from ${s.vendorName}?`)) return;
    await run(
      () => axios.delete(`/api/products/${productId}/sources/${s.id}`),
      "Vendor removed.",
      "Couldn't remove the vendor.",
    );
  };

  const draftInputs = (draft: Draft, set: (d: Draft) => void, label: string) => (
    <>
      <td className="p-2">
        <input
          aria-label={`${label} item number`}
          className={INPUT}
          maxLength={ITEM_NUMBER_MAX}
          value={draft.itemNumber}
          placeholder="Their item number"
          onChange={(e) => set({ ...draft, itemNumber: e.target.value })}
        />
      </td>
      {costVisible && (
        <td className="p-2">
          <input
            aria-label={`${label} cost`}
            className={INPUT}
            type="number"
            min={0}
            step="0.01"
            value={draft.cost}
            placeholder="Their cost"
            onChange={(e) => set({ ...draft, cost: e.target.value })}
          />
        </td>
      )}
    </>
  );

  return (
    <div className="bg-white p-6 rounded-lg shadow-md mb-6">
      <h2 className="text-xl font-semibold mb-1">Other vendors</h2>
      <p className="text-sm text-brand-gray mb-3">
        Vendors this item can also be bought from. A purchase order to one of them orders it under
        their item number and at their cost.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-brand-gray">
            <th className="p-2 font-normal">Vendor</th>
            <th className="p-2 font-normal">Their item number</th>
            {costVisible && <th className="p-2 font-normal">Their cost</th>}
            {canEdit && <th className="p-2" />}
          </tr>
        </thead>
        <tbody>
          {sources.map((s) =>
            editing?.id === s.id ? (
              <tr key={s.id} className="border-t border-brand-gray/10">
                <td className="p-2">{s.vendorName}</td>
                {draftInputs(
                  editing.draft,
                  (d) => setEditing({ id: s.id, draft: d }),
                  s.vendorName,
                )}
                <td className="p-2 whitespace-nowrap text-right">
                  <Button size="sm" onClick={save} disabled={busy}>
                    Save
                  </Button>{" "}
                  <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </td>
              </tr>
            ) : (
              <tr key={s.id} className="border-t border-brand-gray/10">
                <td className="p-2">{s.vendorName}</td>
                <td className="p-2">{s.itemNumber ?? "Our number"}</td>
                {costVisible && (
                  <td className="p-2">{s.cost == null ? "Our cost" : fmt(s.cost)}</td>
                )}
                {canEdit && (
                  <td className="p-2 whitespace-nowrap text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        setEditing({
                          id: s.id,
                          draft: {
                            itemNumber: s.itemNumber ?? "",
                            cost: s.cost == null ? "" : String(s.cost),
                          },
                        })
                      }
                    >
                      Edit
                    </Button>{" "}
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => remove(s)}>
                      Remove
                    </Button>
                  </td>
                )}
              </tr>
            ),
          )}
          {sources.length === 0 && (
            <tr>
              <td className="p-2 text-brand-gray" colSpan={4}>
                Only from its own vendor.
              </td>
            </tr>
          )}
          {canEdit && (
            <tr className="border-t border-brand-gray/10">
              <td className="p-2">
                <select
                  aria-label="Vendor to add"
                  className={INPUT}
                  value={newVendorId}
                  onChange={(e) => setNewVendorId(e.target.value)}
                >
                  <option value="">Add a vendor...</option>
                  {offered.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </td>
              {draftInputs(newDraft, setNewDraft, "New vendor")}
              <td className="p-2 text-right">
                <Button size="sm" onClick={add} disabled={busy || newVendorId === ""}>
                  Add
                </Button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
