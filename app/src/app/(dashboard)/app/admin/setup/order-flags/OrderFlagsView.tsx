"use client";

// /app/src/app/(dashboard)/app/admin/setup/order-flags/OrderFlagsView.tsx
//
// Settings -> Order flags: the store's own flags for orders
// (lib/sales/orderFlags.ts). Add, rename, recolour, set one to warn whoever
// opens an order carrying it, switch off; a flag no order carries can be
// deleted. Reads and writes /api/order-flags.

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import {
  ORDER_FLAG_COLORS,
  ORDER_FLAG_NAME_MAX,
  orderFlagChipClasses,
} from "@/lib/sales/orderFlagsShared";

interface FlagRow {
  id: number;
  name: string;
  color: string;
  alertOnOpen: boolean;
  isActive: boolean;
  sortOrder: number;
  orderCount: number;
}

type Send = (request: Promise<unknown>, done: string) => Promise<boolean>;

const SELECT = "rounded border border-brand-gray/30 px-2 py-1 text-sm";

export function OrderFlagsView() {
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState<string>("gray");
  const [newAlert, setNewAlert] = useState(false);

  // A promise chain rather than an awaited call, so the effect sets no state
  // synchronously (react-hooks/set-state-in-effect).
  const load = useCallback(
    () =>
      axios
        .get<FlagRow[]>("/api/order-flags", { params: { all: 1 } })
        .then((res) => setFlags(res.data))
        .catch((err: unknown) => toast.error(getErrorMessage(err, "Failed to load flags")))
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
      toast.error(getErrorMessage(err, "Couldn't save the flag."));
      return false;
    }
  };

  const add = async () => {
    const ok = await send(
      axios.post("/api/order-flags", {
        name: newName,
        color: newColor,
        alertOnOpen: newAlert,
        sortOrder: flags.length,
      }),
      "Flag added.",
    );
    if (ok) {
      setNewName("");
      setNewAlert(false);
    }
  };

  return (
    <div className="py-2 font-serif">
      <div className="mb-6 max-w-2xl text-brand-gray">
        <p>
          Flags staff put on an order: Call before delivery, Fragile, VIP, Balance owed. They show
          on the order, the orders list and dispatch, and the orders list can show only the orders
          carrying one.
        </p>
        <p className="mt-2 text-sm">
          Turn on <strong>Warn when opened</strong> for a flag everyone must see: opening an order
          that carries it shows it first. A flag orders already carry is switched off rather than
          deleted, so they keep it.
        </p>
      </div>

      <div className="mb-6 flex max-w-2xl flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <label htmlFor="new-flag" className="mb-1 block text-sm text-brand-gray">
            New flag
          </label>
          <input
            id="new-flag"
            value={newName}
            maxLength={ORDER_FLAG_NAME_MAX}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full rounded-md border border-brand-accent-gray px-3 py-2"
          />
        </div>
        <div>
          <label htmlFor="new-flag-color" className="mb-1 block text-sm text-brand-gray">
            Colour
          </label>
          <ColorSelect id="new-flag-color" value={newColor} onChange={setNewColor} />
        </div>
        <label className="flex items-center gap-1 py-2 text-sm text-brand-gray">
          <input
            type="checkbox"
            checked={newAlert}
            onChange={(e) => setNewAlert(e.target.checked)}
          />
          Warn when opened
        </label>
        <Button onClick={add} disabled={!newName.trim()}>
          Add
        </Button>
      </div>

      {loading && <p className="text-brand-gray">Loading...</p>}
      {!loading && flags.length === 0 && <p className="text-brand-gray">No order flags yet.</p>}
      {!loading && flags.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full max-w-4xl border-collapse">
            <thead>
              <tr className="border-b border-brand-gray/30 text-left">
                <th className="py-3 px-4 font-semibold text-brand-blue">Flag</th>
                <th className="py-3 px-4 font-semibold text-brand-blue">Colour</th>
                <th className="py-3 px-4 font-semibold text-brand-blue text-center">
                  Warn when opened
                </th>
                <th className="py-3 px-4 font-semibold text-brand-blue text-right">Orders</th>
                <th className="py-3 px-4 font-semibold text-brand-blue text-center">Status</th>
                <th className="py-3 px-4" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {flags.map((f) => (
                <FlagRowView key={f.id} flag={f} send={send} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ColorSelect({
  id,
  value,
  onChange,
  label,
}: Readonly<{ id?: string; value: string; onChange: (color: string) => void; label?: string }>) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT}
    >
      {ORDER_FLAG_COLORS.map((c) => (
        <option key={c} value={c}>
          {c[0].toUpperCase() + c.slice(1)}
        </option>
      ))}
    </select>
  );
}

function FlagRowView({ flag, send }: Readonly<{ flag: FlagRow; send: Send }>) {
  const [name, setName] = useState(flag.name);
  const url = `/api/order-flags/${flag.id}`;
  return (
    <tr className="border-b border-brand-gray/10 odd:bg-white even:bg-brand-stripe">
      <td className="py-2 px-4">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${orderFlagChipClasses(flag.color)}`}
          >
            {flag.name}
          </span>
          <input
            value={name}
            maxLength={ORDER_FLAG_NAME_MAX}
            onChange={(e) => setName(e.target.value)}
            aria-label={`Name of ${flag.name}`}
            className="w-48 rounded border border-brand-gray/30 px-2 py-1"
          />
          {name.trim() !== flag.name && (
            <button
              type="button"
              onClick={() => send(axios.put(url, { name }), "Renamed.")}
              className="text-sm text-brand-blue underline"
            >
              Save
            </button>
          )}
        </div>
      </td>
      <td className="py-2 px-4">
        <ColorSelect
          label={`Colour of ${flag.name}`}
          value={flag.color}
          onChange={(color) => send(axios.put(url, { color }), "Colour changed.")}
        />
      </td>
      <td className="py-2 px-4 text-center">
        <input
          type="checkbox"
          aria-label={`Warn when an order flagged ${flag.name} is opened`}
          checked={flag.alertOnOpen}
          onChange={(e) =>
            send(
              axios.put(url, { alertOnOpen: e.target.checked }),
              e.target.checked ? "It will warn when opened." : "It won't warn.",
            )
          }
        />
      </td>
      <td className="py-2 px-4 text-right">{flag.orderCount}</td>
      <td className="py-2 px-4 text-center">
        <button
          type="button"
          onClick={() =>
            send(
              axios.put(url, { isActive: !flag.isActive }),
              flag.isActive ? "Switched off." : "Switched on.",
            )
          }
          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
            flag.isActive ? "bg-green-100 text-green-800" : "bg-brand-gray/20 text-brand-gray"
          }`}
        >
          {flag.isActive ? "On" : "Off"}
        </button>
      </td>
      <td className="py-2 px-4 text-right">
        {flag.orderCount === 0 && (
          <button
            type="button"
            onClick={() => send(axios.delete(url), "Deleted.")}
            className="text-sm text-red-600 underline"
          >
            Delete
          </button>
        )}
      </td>
    </tr>
  );
}
