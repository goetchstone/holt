"use client";

// /app/src/app/(dashboard)/app/admin/setup/disclaimers/DisclaimersView.tsx
//
// Settings -> Disclaimers: the store's own disclaimers to print on an order
// (lib/sales/orderDisclaimers.ts). Add, reword, rename, switch off, delete.
// An order given one keeps the text it was given, so rewording or deleting it
// here changes no order. Reads and writes /api/order-disclaimers.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { DISCLAIMER_NAME_MAX, DISCLAIMER_TEXT_MAX } from "@/lib/sales/orderDisclaimersShared";

interface DisclaimerRow {
  id: number;
  name: string;
  text: string;
  isActive: boolean;
  sortOrder: number;
  orderCount: number;
}

type Send = (request: Promise<unknown>, done: string) => Promise<boolean>;

const INPUT = "w-full rounded-md border border-brand-accent-gray px-3 py-2";

export function DisclaimersView() {
  const [disclaimers, setDisclaimers] = useState<DisclaimerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newText, setNewText] = useState("");

  // A promise chain rather than an awaited call, so the effect sets no state
  // synchronously (react-hooks/set-state-in-effect).
  const load = useCallback(
    () =>
      axios
        .get<DisclaimerRow[]>("/api/order-disclaimers", { params: { all: 1 } })
        .then((res) => setDisclaimers(res.data))
        .catch((err: unknown) => toast.error(getErrorMessage(err, "Failed to load disclaimers")))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const send: Send = async (request, done) => {
    try {
      await request;
      toast.success(done);
      await load();
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't save the disclaimer."));
      return false;
    }
  };

  const add = async () => {
    const ok = await send(
      axios.post("/api/order-disclaimers", {
        name: newName,
        text: newText,
        sortOrder: disclaimers.length,
      }),
      "Disclaimer added.",
    );
    if (ok) {
      setNewName("");
      setNewText("");
    }
  };

  return (
    <div className="py-2 font-serif">
      <div className="mb-6 max-w-2xl text-brand-gray">
        <p>
          Disclaimers staff add to an order: Sold as-is, Special order with no cancellations, Floor
          sample. Each prints on the order&apos;s invoice and receipt, above your store-wide footer.
        </p>
        <p className="mt-2 text-sm">
          An order keeps the text it was given. Rewording or deleting a disclaimer here changes no
          order that already has it.
        </p>
      </div>

      <div className="mb-8 max-w-2xl space-y-2">
        <div>
          <label htmlFor="new-disclaimer-name" className="mb-1 block text-sm text-brand-gray">
            Name (what staff pick it by)
          </label>
          <input
            id="new-disclaimer-name"
            value={newName}
            maxLength={DISCLAIMER_NAME_MAX}
            onChange={(e) => setNewName(e.target.value)}
            className={INPUT}
          />
        </div>
        <div>
          <label htmlFor="new-disclaimer-text" className="mb-1 block text-sm text-brand-gray">
            Text (what prints)
          </label>
          <textarea
            id="new-disclaimer-text"
            value={newText}
            maxLength={DISCLAIMER_TEXT_MAX}
            rows={3}
            onChange={(e) => setNewText(e.target.value)}
            className={INPUT}
          />
        </div>
        <Button onClick={add} disabled={!newName.trim() || !newText.trim()}>
          Add
        </Button>
      </div>

      {loading && <p className="text-brand-gray">Loading...</p>}
      {!loading && disclaimers.length === 0 && (
        <p className="text-brand-gray">No disclaimers yet.</p>
      )}
      {!loading && disclaimers.length > 0 && (
        <ul className="max-w-3xl space-y-4">
          {disclaimers.map((d) => (
            <DisclaimerItem key={d.id} disclaimer={d} send={send} />
          ))}
        </ul>
      )}
    </div>
  );
}

function DisclaimerItem({ disclaimer, send }: Readonly<{ disclaimer: DisclaimerRow; send: Send }>) {
  const [name, setName] = useState(disclaimer.name);
  const [text, setText] = useState(disclaimer.text);
  const url = `/api/order-disclaimers/${disclaimer.id}`;
  const changed = name.trim() !== disclaimer.name || text.trim() !== disclaimer.text;
  return (
    <li className="rounded-lg border border-brand-gray/20 bg-white p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={name}
          maxLength={DISCLAIMER_NAME_MAX}
          onChange={(e) => setName(e.target.value)}
          aria-label={`Name of ${disclaimer.name}`}
          className="w-64 rounded border border-brand-gray/30 px-2 py-1 font-semibold"
        />
        <button
          type="button"
          onClick={() =>
            send(
              axios.put(url, { isActive: !disclaimer.isActive }),
              disclaimer.isActive ? "Switched off." : "Switched on.",
            )
          }
          className={`rounded-full px-2 py-0.5 text-xs ${
            disclaimer.isActive ? "bg-green-100 text-green-800" : "bg-brand-gray/20 text-brand-gray"
          }`}
        >
          {disclaimer.isActive ? "On" : "Off"}
        </button>
        <span className="text-xs text-brand-gray">
          On {disclaimer.orderCount} order{disclaimer.orderCount === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          onClick={() => send(axios.delete(url), "Deleted.")}
          className="ml-auto text-sm text-red-600 underline"
        >
          Delete
        </button>
      </div>
      <textarea
        value={text}
        maxLength={DISCLAIMER_TEXT_MAX}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        aria-label={`Text of ${disclaimer.name}`}
        className="w-full rounded border border-brand-gray/30 px-2 py-1 text-sm"
      />
      {changed && (
        <Button size="sm" onClick={() => send(axios.put(url, { name, text }), "Saved.")}>
          Save
        </Button>
      )}
    </li>
  );
}
