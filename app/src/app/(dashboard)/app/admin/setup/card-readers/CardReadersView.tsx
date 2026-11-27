"use client";

// /app/src/app/(dashboard)/app/admin/setup/card-readers/CardReadersView.tsx
//
// The store's card readers: add one by the code on its screen, put it at a
// register, switch it off, remove it. The processor's own state of each
// (online, offline, gone) is shown beside it. See docs/domains/pos.md,
// "Card readers".

import { useCallback, useEffect, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface ReaderRow {
  id: number;
  label: string;
  registerId: number | null;
  registerName: string | null;
  storeName: string | null;
  processor: string;
  deviceType: string | null;
  serialNumber: string | null;
  simulated: boolean;
  isActive: boolean;
  online: boolean | null;
  missingAtProcessor: boolean;
}

interface RegisterOption {
  id: number;
  name: string;
  storeLocation?: { name: string } | null;
}

interface LocationOption {
  id: string;
  name: string;
}

const inputClass = "w-full rounded border border-brand-gray/30 px-2 py-1.5";

function registerLabel(register: RegisterOption): string {
  return register.storeLocation
    ? `${register.storeLocation.name}: ${register.name}`
    : register.name;
}

function readerState(reader: ReaderRow): { text: string; className: string } {
  if (reader.missingAtProcessor) {
    return { text: `Removed at ${reader.processor}`, className: "bg-red-100 text-red-800" };
  }
  if (reader.online === true) return { text: "Online", className: "bg-green-100 text-green-800" };
  if (reader.online === false) {
    return { text: "Offline", className: "bg-amber-100 text-amber-900" };
  }
  return { text: "Unknown", className: "bg-brand-gray/20 text-brand-gray" };
}

export function CardReadersView() {
  const [readers, setReaders] = useState<ReaderRow[]>([]);
  const [registers, setRegisters] = useState<RegisterOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);

  // A promise chain rather than an awaited call, so the effect sets no state
  // synchronously (react-hooks/set-state-in-effect).
  const load = useCallback(
    () =>
      axios
        .get<{ readers: ReaderRow[]; registers: RegisterOption[] }>("/api/card-readers")
        .then((res) => {
          setReaders(res.data.readers);
          setRegisters(res.data.registers);
        })
        .catch((err: unknown) => toast.error(getErrorMessage(err, "Couldn't load card readers.")))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (request: Promise<unknown>, done: string) => {
    try {
      await request;
      toast.success(done);
      await load();
      return true;
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't save the card reader."));
      return false;
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-brand-blue mb-1">Card readers</h1>
        <p className="max-w-3xl text-brand-gray">
          A reader at a register takes that register&rsquo;s card payments: the cashier sends the
          amount to it, the customer taps or inserts their card, and the payment is recorded when it
          is approved. Readers are Stripe&rsquo;s countertop readers, registered on the Stripe
          account in Settings &rsaquo; Integrations. A register with no reader records a card
          payment by hand.
        </p>
      </div>

      {loading && <p className="text-brand-gray">Loading...</p>}
      {!loading && readers.length === 0 && <p className="text-brand-gray">No card readers yet.</p>}
      {!loading && readers.length > 0 && (
        <table className="w-full max-w-5xl border-collapse">
          <thead>
            <tr className="border-b border-brand-gray/30 text-left">
              <th className="py-3 px-4 font-semibold text-brand-blue">Reader</th>
              <th className="py-3 px-4 font-semibold text-brand-blue">Register</th>
              <th className="py-3 px-4 font-semibold text-brand-blue">State</th>
              <th className="py-3 px-4 font-semibold text-brand-blue text-center">In use</th>
              <th className="py-3 px-4" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {readers.map((reader) => (
              <ReaderRowView key={reader.id} reader={reader} registers={registers} send={send} />
            ))}
          </tbody>
        </table>
      )}

      {!adding && (
        <Button variant="primary" onClick={() => setAdding(true)}>
          Add a reader
        </Button>
      )}
      {adding && (
        <AddReaderForm
          registers={registers}
          takenRegisterIds={readers.flatMap((r) => (r.registerId === null ? [] : [r.registerId]))}
          onDone={async (added) => {
            setAdding(false);
            if (added) await load();
          }}
        />
      )}
    </div>
  );
}

function ReaderRowView({
  reader,
  registers,
  send,
}: Readonly<{
  reader: ReaderRow;
  registers: RegisterOption[];
  send: (request: Promise<unknown>, done: string) => Promise<boolean>;
}>) {
  const url = `/api/card-readers/${reader.id}`;
  const state = readerState(reader);
  return (
    <tr className="border-b border-brand-gray/10 odd:bg-white even:bg-brand-stripe">
      <td className="py-2 px-4">
        <div className="font-medium">{reader.label}</div>
        <div className="text-xs text-brand-gray">
          {[reader.simulated ? "Simulated (test mode)" : reader.deviceType, reader.serialNumber]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </td>
      <td className="py-2 px-4">
        <select
          aria-label={`Register for ${reader.label}`}
          value={reader.registerId ?? ""}
          onChange={(e) =>
            send(
              axios.put(url, { registerId: e.target.value === "" ? null : Number(e.target.value) }),
              "Register changed.",
            )
          }
          className="rounded border border-brand-gray/30 px-2 py-1"
        >
          <option value="">No register</option>
          {registers.map((register) => (
            <option key={register.id} value={register.id}>
              {registerLabel(register)}
            </option>
          ))}
        </select>
      </td>
      <td className="py-2 px-4">
        <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${state.className}`}>
          {state.text}
        </span>
      </td>
      <td className="py-2 px-4 text-center">
        <button
          type="button"
          onClick={() =>
            send(
              axios.put(url, { isActive: !reader.isActive }),
              reader.isActive ? "Switched off." : "Switched on.",
            )
          }
          className={`inline-block rounded-full px-2 py-0.5 text-xs ${
            reader.isActive ? "bg-green-100 text-green-800" : "bg-brand-gray/20 text-brand-gray"
          }`}
        >
          {reader.isActive ? "On" : "Off"}
        </button>
      </td>
      <td className="py-2 px-4 text-right">
        <button
          type="button"
          onClick={() => {
            if (
              globalThis.confirm(
                `Remove "${reader.label}"? It is removed from ${reader.processor} too, and has to be registered again to be used.`,
              )
            ) {
              void send(axios.delete(url), "Reader removed.");
            }
          }}
          className="text-sm text-red-600 underline"
        >
          Remove
        </button>
      </td>
    </tr>
  );
}

const NEW_LOCATION = "__new__";
const EMPTY_ADDRESS = { name: "", line1: "", city: "", state: "", postalCode: "", country: "" };

function AddReaderForm({
  registers,
  takenRegisterIds,
  onDone,
}: Readonly<{
  registers: RegisterOption[];
  takenRegisterIds: number[];
  onDone: (added: boolean) => Promise<void>;
}>) {
  const [locations, setLocations] = useState<LocationOption[] | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [locationId, setLocationId] = useState("");
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [registrationCode, setRegistrationCode] = useState("");
  const [label, setLabel] = useState("");
  const [registerId, setRegisterId] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    axios
      .get<{ locations: LocationOption[] }>("/api/card-readers/locations")
      .then((res) => {
        setLocations(res.data.locations);
        setLocationId(res.data.locations[0]?.id ?? NEW_LOCATION);
      })
      .catch((err: unknown) =>
        setLocationError(getErrorMessage(err, "Couldn't reach the card processor.")),
      );
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      let location = locationId;
      if (location === NEW_LOCATION) {
        const made = await axios.post<LocationOption>("/api/card-readers/locations", address);
        location = made.data.id;
        setLocations((current) => [...(current ?? []), made.data]);
        setLocationId(made.data.id);
      }
      await axios.post("/api/card-readers", {
        registrationCode,
        label,
        locationId: location,
        registerId: registerId === "" ? null : Number(registerId),
      });
      toast.success("Reader added.");
      await onDone(true);
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't add the reader."));
    } finally {
      setSaving(false);
    }
  };

  if (locationError) {
    return (
      <div className="max-w-2xl rounded border border-amber-300 bg-amber-50 p-4 text-sm">
        <p className="font-medium">A reader can&rsquo;t be added yet.</p>
        <p className="mt-1">{locationError}</p>
        <p className="mt-1">
          Check the Stripe key in Settings &rsaquo; Integrations, then try again.
        </p>
        <Button variant="secondary" className="mt-3" onClick={() => void onDone(false)}>
          Close
        </Button>
      </div>
    );
  }
  if (locations === null) return <p className="text-brand-gray">Asking the card processor...</p>;

  const field = (key: keyof typeof EMPTY_ADDRESS, name: string, placeholder?: string) => (
    <label className="block text-sm">
      <span className="mb-1 block text-brand-gray">{name}</span>
      <input
        value={address[key]}
        placeholder={placeholder}
        onChange={(e) => setAddress({ ...address, [key]: e.target.value })}
        className={inputClass}
      />
    </label>
  );

  return (
    <div className="max-w-2xl space-y-4 rounded border border-brand-gray/30 bg-white p-4">
      <h2 className="text-lg font-semibold text-brand-blue">Add a reader</h2>
      <label className="block text-sm">
        <span className="mb-1 block text-brand-gray">Code shown on the reader</span>
        <input
          value={registrationCode}
          onChange={(e) => setRegistrationCode(e.target.value)}
          placeholder="three words, e.g. sepia-cerulean-aqua"
          className={inputClass}
        />
        <span className="mt-1 block text-xs text-brand-gray">
          On the reader, open its settings and choose to generate a pairing code. With a Stripe test
          key, the code <code>simulated-wpe</code> adds a simulated reader, with no hardware.
        </span>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-brand-gray">Name for the reader</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Front counter"
          className={inputClass}
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-brand-gray">Register it sits at</span>
        <select
          value={registerId}
          onChange={(e) => setRegisterId(e.target.value)}
          className={inputClass}
        >
          <option value="">No register yet</option>
          {registers
            .filter((register) => !takenRegisterIds.includes(register.id))
            .map((register) => (
              <option key={register.id} value={register.id}>
                {registerLabel(register)}
              </option>
            ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-brand-gray">Where the reader is (at Stripe)</span>
        <select
          value={locationId}
          onChange={(e) => setLocationId(e.target.value)}
          className={inputClass}
        >
          {locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.name}
            </option>
          ))}
          <option value={NEW_LOCATION}>A new location...</option>
        </select>
      </label>
      {locationId === NEW_LOCATION && (
        <div className="grid grid-cols-1 gap-3 rounded bg-brand-stripe p-3 sm:grid-cols-2">
          {field("name", "Location name", "Main Street showroom")}
          {field("line1", "Street address")}
          {field("city", "City")}
          {field("state", "State or province")}
          {field("postalCode", "Postal code")}
          {field("country", "Country (two letters)", "US")}
        </div>
      )}
      <div className="flex gap-3">
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "Adding..." : "Add reader"}
        </Button>
        <Button variant="secondary" onClick={() => void onDone(false)} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
