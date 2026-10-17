// /app/src/components/modals/VendorDetailModal.tsx
"use client";

import { useEffect, useState } from "react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";
import { VENDOR_DETAIL_FIELDS } from "@/lib/vendorPatch";
import { MAX_LEAD_TIME_DAYS } from "@/lib/vendorLeadTime";

export default function VendorDetailModal({
  vendor,
  onClose,
  onRefresh,
}: {
  vendor: any;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ ...vendor });
  const [contacts, setContacts] = useState<any[]>([]);

  const [newContact, setNewContact] = useState({
    name: "",
    email: "",
    phone: "",
    role: "",
  });

  const fetchContacts = async () => {
    try {
      const res = await fetch(`/api/vendors/${vendor.id}/contacts`);
      const data = await res.json();

      if (Array.isArray(data)) {
        setContacts(data);
      } else {
        setContacts([]);
      }
    } catch (err) {
      toast.error(getErrorMessage(err, "Failed to load contacts."));
      setContacts([]);
    }
  };

  const handleSave = async () => {
    // Only what this form edits. Sending the whole vendor back also re-sent its
    // pricing defaults, which this form neither shows nor owns.
    const body: Record<string, unknown> = { leadTimeDays: form.leadTimeDays ?? null };
    for (const field of VENDOR_DETAIL_FIELDS) body[field] = form[field] ?? null;
    const res = await fetch(`/api/vendors/${vendor.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setEditing(false);
      onRefresh();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || `Failed to update vendor (${res.status})`);
    }
  };

  const handleAddContact = async () => {
    const { name, email, phone, role } = newContact;

    if (!name.trim()) {
      alert("Contact name is required");
      return;
    }

    try {
      const res = await fetch(`/api/vendors/${vendor.id}/contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, phone, role }),
      });

      if (res.ok) {
        setNewContact({ name: "", email: "", phone: "", role: "" });
        fetchContacts();
      } else {
        alert("Failed to add contact");
      }
    } catch {
      alert("Server error");
    }
  };

  const handleDeleteContact = async (contactId: number) => {
    const confirmed = confirm("Are you sure you want to delete this contact?");
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/vendors/${vendor.id}/contacts?contactId=${contactId}`, {
        method: "DELETE",
      });

      if (res.ok) {
        fetchContacts(); // refresh after deletion
      } else {
        alert("Failed to delete contact.");
      }
    } catch {
      alert("Server error.");
    }
  };

  useEffect(() => {
    fetchContacts();
  }, [vendor.id]);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded-lg shadow-xl max-w-2xl w-full font-serif">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-brand-blue">Vendor: {vendor.name}</h2>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {VENDOR_DETAIL_FIELDS.map((field) => (
            <input
              key={field}
              type="text"
              disabled={!editing}
              placeholder={field.toUpperCase()}
              aria-label={field}
              value={form[field] || ""}
              onChange={(e) => setForm({ ...form, [field]: e.target.value })}
              className="w-full border border-brand-gray rounded-lg px-3 py-2 text-brand-black font-serif"
            />
          ))}
          <label className="flex items-center gap-3 text-sm text-brand-gray">
            <span className="whitespace-nowrap">Standard lead time</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_LEAD_TIME_DAYS}
              step={1}
              disabled={!editing}
              placeholder="Not set"
              value={form.leadTimeDays ?? ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  leadTimeDays: e.target.value === "" ? null : Number(e.target.value),
                })
              }
              className="w-24 border border-brand-gray rounded-lg px-3 py-2 text-brand-black font-serif"
            />
            <span>days</span>
          </label>
        </div>
        <p className="mt-2 text-xs text-brand-gray">
          A special order raised at the register is expected this many days after it is placed.
          Leave it empty if you don&apos;t know it: the PO then shows no date until the vendor
          confirms one.
        </p>

        {editing ? (
          <div className="mt-4 flex justify-end">
            <Button variant="primary" onClick={handleSave}>
              Save
            </Button>
          </div>
        ) : (
          <div className="mt-4 flex justify-end">
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>
        )}

        <div className="mt-6">
          <h3 className="text-md font-semibold mb-2">Contacts</h3>

          {Array.isArray(contacts) && contacts.length > 0 ? (
            <ul className="text-sm space-y-1">
              {contacts.map((c) => (
                <li key={c.id} className="border p-2 rounded flex justify-between items-start">
                  <div>
                    <strong>{c.name}</strong> {c.role ? `(${c.role})` : ""}
                    <br />
                    {c.email} • {c.phone}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => handleDeleteContact(c.id)}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-brand-gray">No contacts</p>
          )}

          <div className="mt-4 space-y-2">
            <h4 className="text-sm font-semibold">Add Contact</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="Name"
                value={newContact.name}
                onChange={(e) => setNewContact({ ...newContact, name: e.target.value })}
                className="w-full border border-brand-gray rounded-lg px-3 py-2 text-brand-black font-serif"
              />
              <input
                type="text"
                placeholder="Role"
                value={newContact.role}
                onChange={(e) => setNewContact({ ...newContact, role: e.target.value })}
                className="w-full border border-brand-gray rounded-lg px-3 py-2 text-brand-black font-serif"
              />
              <input
                type="email"
                placeholder="Email"
                value={newContact.email}
                onChange={(e) => setNewContact({ ...newContact, email: e.target.value })}
                className="w-full border border-brand-gray rounded-lg px-3 py-2 text-brand-black font-serif"
              />
              <input
                type="text"
                placeholder="Phone"
                value={newContact.phone}
                onChange={(e) => setNewContact({ ...newContact, phone: e.target.value })}
                className="w-full border border-brand-gray rounded-lg px-3 py-2 text-brand-black font-serif"
              />
            </div>
            <div className="text-right mt-2">
              <Button variant="primary" onClick={handleAddContact}>
                Add Contact
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
