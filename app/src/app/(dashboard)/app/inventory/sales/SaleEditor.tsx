"use client";

// /app/src/app/(dashboard)/app/inventory/sales/SaleEditor.tsx
//
// One sale on the Sales screen (GAP-06 part B, DECISIONS 60): a new one, or an
// existing one opened from the list. What may change follows where it stands
// on the store's day (lib/pricing/salesShared.ts):
//
//   new / UPCOMING  name, note, dates and products; an upcoming one can be deleted.
//   ON              name and note; it can be ended early.
//   ENDED           name and note. Its products stay as the record of what was charged.
//
// Products are added the mass price change's way (components/pricing/ProductPicker)
// and priced by a percent off the regular price or a typed amount. The server
// previews each price and says why any is left out; "Add to the sale" puts the
// priced rows in the draft, and Save sends the whole draft, which the server
// checks again in one transaction (overlap, below regular) before writing.

import { useCallback, useEffect, useMemo, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { useLocale, useMoneyFormatter } from "@/components/branding/BrandingProvider";
import {
  FilterBar,
  ProductTable,
  SelectionSummary,
  pickerFieldCls as fieldCls,
  pickerLabelCls as labelCls,
  plural,
  useProductPicker,
} from "@/components/pricing/ProductPicker";
import { getErrorMessage } from "@/lib/toastError";
import { RETAIL_ROUNDINGS, RETAIL_ROUNDING_LABELS, isRetailRounding } from "@/lib/pricing/rounding";
import type { RetailRounding } from "@/lib/pricing/rounding";
import {
  SALE_NAME_MAX,
  SALE_NOTE_MAX,
  SALE_SKIPS,
  SALE_STATUS_LABELS,
  addPreviewToItems,
  itemsToSave,
  saleDayText,
  saleSizeProblem,
  type SaleDetail,
  type SaleItemRow,
  type SalePatch,
  type SalePreviewRow,
  type SalePricing,
  type SaleSkip,
  type SaleStatus,
} from "@/lib/pricing/salesShared";

const STATUS_CLS: Record<SaleStatus, string> = {
  ON: "bg-green-100 text-green-900",
  UPCOMING: "bg-brand-blue/10 text-brand-blue",
  ENDED: "bg-brand-gray/15 text-brand-gray",
};

export function SaleStatusChip({
  status,
  endedEarly,
}: Readonly<{ status: SaleStatus; endedEarly: boolean }>) {
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${STATUS_CLS[status]}`}>
      {endedEarly ? "Ended early" : SALE_STATUS_LABELS[status]}
    </span>
  );
}

interface PreviewResponse {
  rows: SalePreviewRow[];
  toSave: number;
  skipped: Partial<Record<SaleSkip, number>>;
  rounding: RetailRounding | null;
}

type Fmt = (value: number | null | undefined) => string;

function percentOff(regular: number | null, sale: number): string {
  if (regular === null || regular <= 0) return "";
  return `${Math.round((1 - sale / regular) * 100)}%`;
}

function skipReason(row: SalePreviewRow): string {
  if (!row.skipped) return "";
  if (row.skipped === "OVERLAPS" && row.overlaps) {
    return `Already in "${row.overlaps.name}" on some of these days`;
  }
  return SALE_SKIPS[row.skipped];
}

/** The sale's products, with a remove button while they can still change. */
function SaleItemsTable({
  items,
  fmt,
  onRemove,
}: Readonly<{ items: SaleItemRow[]; fmt: Fmt; onRemove: ((id: number) => void) | null }>) {
  if (items.length === 0) {
    return <p className="text-sm text-brand-gray">No products in this sale yet.</p>;
  }
  return (
    <div className="max-h-[420px] overflow-auto border border-brand-gray/20 rounded bg-white">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-brand-gray/20 text-left text-xs text-brand-gray uppercase tracking-wide">
            <th className="px-3 py-2">Part #</th>
            <th className="px-3 py-2">Name</th>
            <th className="px-3 py-2 text-right">Regular</th>
            <th className="px-3 py-2 text-right">Sale</th>
            <th className="px-3 py-2 text-right">Off</th>
            {onRemove && <th className="px-3 py-2" />}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.productId} className="border-b border-brand-gray/10">
              <td className="px-3 py-2 font-mono text-xs">{i.productNumber}</td>
              <td className="px-3 py-2">{i.name}</td>
              <td className="px-3 py-2 text-right tabular-nums text-brand-gray">
                {i.regularPrice === null ? "none" : fmt(i.regularPrice)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold">
                {fmt(i.salePrice)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-brand-gray">
                {percentOff(i.regularPrice, i.salePrice)}
              </td>
              {onRemove && (
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => onRemove(i.productId)}
                    className="text-xs text-red-600 underline"
                    aria-label={`Take ${i.name} out of the sale`}
                  >
                    Remove
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreviewPanel({
  preview,
  fmt,
  onAdd,
}: Readonly<{ preview: PreviewResponse; fmt: Fmt; onAdd: () => void }>) {
  const [showSkipped, setShowSkipped] = useState(false);
  const leftOut = preview.rows.length - preview.toSave;
  const shown = showSkipped ? preview.rows : preview.rows.filter((r) => !r.skipped);
  const skippedEntries = Object.entries(preview.skipped) as [SaleSkip, number][];
  return (
    <div className="bg-white border border-brand-blue/40 rounded-lg p-4 space-y-4">
      <div>
        <h3 className="text-base font-semibold text-brand-blue">Preview</h3>
        <p className="text-sm text-brand-black">
          {plural(preview.toSave, "product")} priced.
          {leftOut > 0 && ` ${plural(leftOut, "product")} left out.`}
          {preview.rounding
            ? ` Sale prices are rounded ${RETAIL_ROUNDING_LABELS[preview.rounding].toLowerCase()}.`
            : " An amount you typed is used as typed."}
        </p>
        {skippedEntries.length > 0 && (
          <ul className="mt-1 text-xs text-brand-gray list-disc pl-5">
            {skippedEntries.map(([reason, n]) => (
              <li key={reason}>
                {SALE_SKIPS[reason]}: {n.toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </div>
      {leftOut > 0 && (
        <label className="flex items-center gap-2 text-sm text-brand-black">
          <input
            type="checkbox"
            checked={showSkipped}
            onChange={(e) => setShowSkipped(e.target.checked)}
          />
          Show the ones left out
        </label>
      )}
      <div className="max-h-[360px] overflow-auto border border-brand-gray/20 rounded">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-brand-gray/20 text-left text-xs text-brand-gray uppercase tracking-wide">
              <th className="px-3 py-2">Part #</th>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2 text-right">Regular</th>
              <th className="px-3 py-2 text-right">Sale</th>
              <th className="px-3 py-2">Left out because</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-brand-gray">
                  Nothing to add.
                </td>
              </tr>
            ) : (
              shown.map((r) => (
                <tr
                  key={r.productId}
                  className={`border-b border-brand-gray/10 ${r.skipped ? "text-brand-gray" : ""}`}
                >
                  <td className="px-3 py-2 font-mono text-xs">{r.productNumber}</td>
                  <td className="px-3 py-2">{r.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.regularPrice === null ? "none" : fmt(r.regularPrice)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.salePrice === null ? "—" : fmt(r.salePrice)}
                  </td>
                  <td className="px-3 py-2 text-xs">{skipReason(r)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <Button onClick={onAdd} disabled={preview.toSave === 0} className="min-h-[40px] px-6">
        Add {plural(preview.toSave, "product")} to the sale
      </Button>
    </div>
  );
}

/** Choose products and price them; the priced rows go into the draft. */
function AddProducts({
  dates,
  saleId,
  fmt,
  onAdd,
}: Readonly<{
  dates: { startsOn: string; endsOn: string };
  saleId: number | null;
  fmt: Fmt;
  onAdd: (rows: SalePreviewRow[]) => void;
}>) {
  const picker = useProductPicker();
  const [kind, setKind] = useState<SalePricing["kind"]>("PERCENT_OFF");
  const [percent, setPercent] = useState("");
  const [amount, setAmount] = useState("");
  const [rounding, setRounding] = useState<RetailRounding | "">("");
  const [preview, setPreview] = useState<(PreviewResponse & { key: string }) | null>(null);
  const [busy, setBusy] = useState(false);

  const pricing: SalePricing = useMemo(
    () =>
      kind === "PERCENT_OFF"
        ? { kind, percent: Number(percent), ...(rounding && { rounding }) }
        : { kind, amount: Number(amount) },
    [kind, percent, amount, rounding],
  );
  const datesSet = Boolean(dates.startsOn && dates.endsOn);
  // A preview answers for one selection, pricing and run of days.
  const key = JSON.stringify({ selection: picker.selection, pricing, dates });
  const currentPreview = preview?.key === key ? preview : null;

  const runPreview = async () => {
    setBusy(true);
    try {
      const res = await axios.post<PreviewResponse>("/api/pricing/sales/preview", {
        selection: picker.selection,
        pricing,
        startsOn: dates.startsOn,
        endsOn: dates.endsOn,
        saleId,
      });
      setPreview({ ...res.data, key });
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't work out the sale prices."));
    } finally {
      setBusy(false);
    }
  };

  const add = () => {
    if (!currentPreview) return;
    onAdd(currentPreview.rows);
    setPreview(null);
    picker.clearSelection();
  };

  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold text-brand-blue">Add products</h3>
      <FilterBar
        options={picker.options}
        filter={picker.filter}
        onFilter={picker.changeFilter}
        idPrefix="sale"
      />
      <div className="bg-brand-linen border border-brand-gray/20 rounded-lg p-4 space-y-4">
        <SelectionSummary picker={picker} capFor="A sale" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label htmlFor="sale-pricing" className={labelCls}>
              Sale price
            </label>
            <select
              id="sale-pricing"
              value={kind}
              onChange={(e) => setKind(e.target.value as SalePricing["kind"])}
              className={fieldCls}
            >
              <option value="PERCENT_OFF">A percent off the regular price</option>
              <option value="AMOUNT">An amount, the same for each</option>
            </select>
          </div>
          {kind === "PERCENT_OFF" ? (
            <>
              <div>
                <label htmlFor="sale-percent" className={labelCls}>
                  Percent off
                </label>
                <input
                  id="sale-percent"
                  type="number"
                  min={0}
                  max={99.99}
                  step="any"
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                  placeholder="e.g. 20"
                  className={fieldCls}
                />
              </div>
              <div>
                <label htmlFor="sale-rounding" className={labelCls}>
                  Rounding
                </label>
                <select
                  id="sale-rounding"
                  value={rounding}
                  onChange={(e) =>
                    setRounding(isRetailRounding(e.target.value) ? e.target.value : "")
                  }
                  className={fieldCls}
                >
                  <option value="">The store&apos;s rule</option>
                  {RETAIL_ROUNDINGS.map((r) => (
                    <option key={r} value={r}>
                      {RETAIL_ROUNDING_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <div>
              <label htmlFor="sale-amount" className={labelCls}>
                Sale price, to the cent
              </label>
              <input
                id="sale-amount"
                type="number"
                min={0.01}
                step={0.01}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={fieldCls}
              />
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={runPreview}
            disabled={picker.count === 0 || picker.tooMany || !datesSet || busy}
            className="min-h-[40px] px-6"
          >
            {busy ? "Working it out…" : "Preview"}
          </Button>
          {!datesSet && (
            <span className="text-xs text-brand-gray">
              Set the sale&apos;s dates first: a product can be in one sale a day.
            </span>
          )}
        </div>
      </div>
      {currentPreview && <PreviewPanel preview={currentPreview} fmt={fmt} onAdd={add} />}
      <ProductTable picker={picker} />
    </div>
  );
}

/** What a save sends for an existing sale: only what changed, and only what it may change. */
function patchFor(
  sale: SaleDetail,
  draft: { name: string; note: string; startsOn: string; endsOn: string; items: SaleItemRow[] },
): SalePatch {
  const patch: SalePatch = {};
  if (draft.name.trim() !== sale.name) patch.name = draft.name;
  if ((draft.note.trim() || null) !== sale.note) patch.note = draft.note;
  if (sale.status !== "UPCOMING") return patch;
  if (draft.startsOn !== sale.startsOn || draft.endsOn !== sale.endsOn) {
    patch.startsOn = draft.startsOn;
    patch.endsOn = draft.endsOn;
  }
  const key = (items: SaleItemRow[]) =>
    JSON.stringify(itemsToSave(items).sort((a, b) => a.productId - b.productId));
  if (key(draft.items) !== key(sale.items)) patch.items = itemsToSave(draft.items);
  return patch;
}

export function SaleEditor({
  saleId,
  today,
  onSaved,
  onGone,
}: Readonly<{
  saleId: number | null;
  today: string;
  onSaved: (id: number) => void;
  onGone: () => void;
}>) {
  const fmt = useMoneyFormatter();
  const { locale } = useLocale();
  const [sale, setSale] = useState<SaleDetail | null>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState("");
  const [items, setItems] = useState<SaleItemRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback((detail: SaleDetail) => {
    setSale(detail);
    setName(detail.name);
    setNote(detail.note ?? "");
    setStartsOn(detail.startsOn);
    setEndsOn(detail.endsOn);
    setItems(detail.items);
  }, []);

  useEffect(() => {
    if (saleId === null) return;
    let live = true;
    axios
      .get<SaleDetail>(`/api/pricing/sales/${saleId}`)
      .then((res) => {
        if (live) load(res.data);
      })
      .catch((err) => {
        if (live) toast.error(getErrorMessage(err, "Couldn't load the sale."));
      });
    return () => {
      live = false;
    };
  }, [saleId, load]);

  if (saleId !== null && !sale) return <p className="text-sm text-brand-gray">Loading…</p>;

  const status: SaleStatus | null = sale?.status ?? null;
  const runEditable = status === null || status === "UPCOMING";
  const saveLabel = sale ? "Save changes" : "Schedule the sale";
  // Each "Add to the sale" round adds to the draft, so the cap is checked here too.
  const tooBig = runEditable ? saleSizeProblem(items.length) : null;

  const save = async () => {
    setBusy(true);
    try {
      if (!sale) {
        const res = await axios.post<{ id: number }>("/api/pricing/sales", {
          name,
          note,
          startsOn,
          endsOn,
          items: itemsToSave(items),
        });
        toast.success(`Sale scheduled: ${plural(items.length, "product")}.`);
        onSaved(res.data.id);
        return;
      }
      const patch = patchFor(sale, { name, note, startsOn, endsOn, items });
      if (Object.keys(patch).length === 0) {
        toast.info("Nothing has changed.");
        return;
      }
      const res = await axios.patch<SaleDetail>(`/api/pricing/sales/${sale.id}`, patch);
      load(res.data);
      toast.success("Sale saved.");
      onSaved(sale.id);
    } catch (err) {
      toast.error(getErrorMessage(err, "The sale wasn't saved."));
    } finally {
      setBusy(false);
    }
  };

  const endEarly = async () => {
    if (!sale) return;
    if (
      !globalThis.confirm(
        `End "${sale.name}" now? Its sale prices stop at once and it can't be restarted. Its products stay on it as the record of what was charged.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await axios.post<SaleDetail>(`/api/pricing/sales/${sale.id}/end`);
      load(res.data);
      toast.success("Sale ended. Print the regular tags from Tags to change.");
      onSaved(sale.id);
    } catch (err) {
      toast.error(getErrorMessage(err, "The sale wasn't ended."));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!sale) return;
    if (
      !globalThis.confirm(
        `Delete "${sale.name}"? It hasn't started, so nothing was sold at its prices.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await axios.delete(`/api/pricing/sales/${sale.id}`);
      toast.success("Sale deleted.");
      onGone();
    } catch (err) {
      toast.error(getErrorMessage(err, "The sale wasn't deleted."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-brand-blue">{sale ? sale.name : "New sale"}</h1>
        {sale && <SaleStatusChip status={sale.status} endedEarly={sale.endedEarlyAt !== null} />}
      </div>
      {sale?.status === "ON" && (
        <p className="text-sm text-brand-gray">
          This sale is on. Its dates and products can&apos;t change now; end it early to stop its
          prices today.
        </p>
      )}
      {sale?.status === "ENDED" && (
        <p className="text-sm text-brand-gray">
          This sale has ended
          {sale.endedEarlyBy ? ` (ended early by ${sale.endedEarlyBy})` : ""}. Its products stay
          here as the record of what was charged.
        </p>
      )}

      <div className="bg-white border border-brand-gray/20 rounded-lg p-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="md:col-span-2">
          <label htmlFor="sale-name" className={labelCls}>
            Name
          </label>
          <input
            id="sale-name"
            value={name}
            maxLength={SALE_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Spring Sale"
            className={fieldCls}
          />
        </div>
        <div>
          <label htmlFor="sale-starts" className={labelCls}>
            First day
          </label>
          <input
            id="sale-starts"
            type="date"
            min={today}
            value={startsOn}
            disabled={!runEditable}
            onChange={(e) => setStartsOn(e.target.value)}
            className={`${fieldCls} disabled:bg-brand-linen disabled:text-brand-gray`}
          />
        </div>
        <div>
          <label htmlFor="sale-ends" className={labelCls}>
            Last day
          </label>
          <input
            id="sale-ends"
            type="date"
            min={startsOn || today}
            value={endsOn}
            disabled={!runEditable}
            onChange={(e) => setEndsOn(e.target.value)}
            className={`${fieldCls} disabled:bg-brand-linen disabled:text-brand-gray`}
          />
        </div>
        <div className="md:col-span-4">
          <label htmlFor="sale-note" className={labelCls}>
            Note (optional)
          </label>
          <input
            id="sale-note"
            value={note}
            maxLength={SALE_NOTE_MAX}
            onChange={(e) => setNote(e.target.value)}
            className={fieldCls}
          />
        </div>
        <p className="md:col-span-4 text-xs text-brand-gray">
          Days are the store&apos;s days: the sale runs from the start of its first day to the end
          of its last
          {startsOn && endsOn
            ? `, ${saleDayText(startsOn, locale)} to ${saleDayText(endsOn, locale)}`
            : ""}
          .
        </p>
      </div>

      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-brand-blue">
          Products ({items.length.toLocaleString()})
        </h2>
        {tooBig && (
          <p role="alert" className="text-sm text-red-700">
            {tooBig}
          </p>
        )}
        <SaleItemsTable
          items={items}
          fmt={fmt}
          onRemove={
            runEditable ? (id) => setItems((prev) => prev.filter((i) => i.productId !== id)) : null
          }
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={save} disabled={busy || tooBig !== null} className="min-h-[40px] px-6">
          {busy ? "Saving…" : saveLabel}
        </Button>
        {sale?.status === "ON" && (
          <Button variant="outline" onClick={endEarly} disabled={busy} className="min-h-[40px]">
            End early
          </Button>
        )}
        {sale?.status === "UPCOMING" && (
          <Button variant="outline" onClick={remove} disabled={busy} className="min-h-[40px]">
            Delete
          </Button>
        )}
        {runEditable && (
          <span className="text-xs text-brand-gray">
            Saving checks every product again: each must still be below its regular price and in no
            other sale on these days.
          </span>
        )}
      </div>

      {runEditable && (
        <AddProducts
          dates={{ startsOn, endsOn }}
          saleId={sale?.id ?? null}
          fmt={fmt}
          onAdd={(rows) => setItems((prev) => addPreviewToItems(prev, rows))}
        />
      )}
    </div>
  );
}
