// /app/src/components/modals/PrinterModal.tsx

import { useState, useEffect } from "react";
import { Printer } from "@prisma/client";
import FormInput from "@/components/form/FormInput";
import { Button } from "@/components/ui/button";
import Modal from "@/components/ui/Modal";

type Props = {
  printer: Printer | null; // Can be null for new printer
  onClose: () => void;
  onRefresh: () => void; // Callback to refresh parent list
};

export default function PrinterModal({ printer, onClose, onRefresh }: Props) {
  const [form, setForm] = useState({
    name: "",
    ipAddress: "",
    port: "9100",
    location: "",
    tagType: "",
    store: "",
    currentSize: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (printer) {
      setForm({
        name: printer.name || "",
        ipAddress: printer.ipAddress || "",
        port: printer.port?.toString() || "9100",
        location: printer.location || "",
        tagType: printer.tagType || "",
        store: printer.store || "",
        currentSize: printer.currentSize || "",
      });
    } else {
      setForm({
        name: "",
        ipAddress: "",
        port: "9100",
        location: "",
        tagType: "",
        store: "",
        currentSize: "",
      });
    }
  }, [printer]);

  const handleChange = (name: string, value: string) => {
    setForm({
      ...form,
      [name]: value,
    });
  };

  const handleSubmit = async () => {
    setSaving(true);
    const method = printer ? "PUT" : "POST";
    const url = printer ? `/api/printers/${printer.id}` : "/api/printers"; // Use new single-printer API for PUT

    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const errorData = await res.json();
        alert(`Failed to save printer: ${errorData.error || errorData.message || "Unknown error"}`);
      }
    } catch {
      alert("Error occurred while saving.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!printer || !printer.id) return;

    const confirmed = confirm(
      `Are you sure you want to delete printer "${printer.name}"? This action cannot be undone.`,
    );
    if (!confirmed) return;

    setSaving(true);
    try {
      const res = await fetch(`/api/printers/${printer.id}`, {
        method: "DELETE",
      });

      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        const errorData = await res.json();
        alert(
          `Failed to delete printer: ${errorData.error || errorData.message || "Unknown error"}`,
        );
      }
    } catch {
      alert("Error occurred while deleting.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={printer ? "Edit Printer" : "Add Printer"}
      onClose={onClose}
      onSave={handleSubmit}
      saving={saving}
    >
      <FormInput
        label="Printer Name"
        name="name"
        value={form.name}
        onChange={(v) => handleChange("name", v)}
        required
      />
      <FormInput
        label="IP Address"
        name="ipAddress"
        value={form.ipAddress}
        onChange={(v) => handleChange("ipAddress", v)}
        required
      />
      <FormInput
        label="Port"
        name="port"
        type="number"
        value={form.port}
        onChange={(v) => handleChange("port", v)}
        required
      />
      <FormInput
        label="Location"
        name="location"
        value={form.location}
        onChange={(v) => handleChange("location", v)}
        required
      />
      <FormInput
        label="Tag Type"
        name="tagType"
        value={form.tagType}
        onChange={(v) => handleChange("tagType", v)}
        required
      />
      <FormInput
        label="Store"
        name="store"
        value={form.store}
        onChange={(v) => handleChange("store", v)}
        required
      />
      <FormInput
        label="Loaded Tag Size"
        name="currentSize"
        value={form.currentSize}
        onChange={(v) => handleChange("currentSize", v)}
        placeholder="e.g. 4x6, 2x1 -- must match a label template's tag size"
      />

      <div className="flex justify-end gap-4 mt-4">
        {printer && ( // Only show delete button for existing printers
          <Button variant="secondary" onClick={handleDelete} disabled={saving}>
            Delete
          </Button>
        )}
      </div>
    </Modal>
  );
}
