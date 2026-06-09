// /app/src/components/modals/ProductEditModal.tsx

import { useState } from "react";
import FormInput from "@/components/form/FormInput";
import FormCurrencyInput from "@/components/form/FormCurrencyInput";
import { Button } from "@/components/ui/button";

export default function ProductEditModal({
  product,
  onClose,
  onSave,
}: {
  product: any;
  onClose: () => void;
  onSave: () => void;
}) {
  const [form, setForm] = useState({
    name: product.name || "",
    productNumber: product.productNumber || "",
    description: product.description || "",
    season: product.season || "",
    baseRetail: product.baseRetail ?? "",
    length: product.length ?? "",
    depth: product.depth ?? "",
    height: product.height ?? "",
    serviceType: product.serviceType || "",
  });

  const handleChange = (name: string, value: string) => {
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSave = async () => {
    const res = await fetch(`/api/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });

    if (res.ok) {
      onSave();
    } else {
      alert("Error saving product.");
    }
  };

  const handlePrint = async () => {
    const res = await fetch("/api/print-label", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        productId: product.id,
        templateId: "", // will need template selector in future
        printerId: "", // will need printer selector in future
      }),
    });

    if (res.ok) {
      alert("Label sent to printer.");
    } else {
      alert("Error printing label.");
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white p-6 rounded-lg shadow-xl max-w-2xl w-full font-serif">
        <h2 className="text-xl font-semibold text-sh-blue mb-4">Edit Product</h2>

        <div className="grid grid-cols-2 gap-4 mb-4">
          <FormInput
            label="Product #"
            name="productNumber"
            value={form.productNumber}
            onChange={(v) => handleChange("productNumber", v)}
          />
          <FormInput
            label="Name"
            name="name"
            value={form.name}
            onChange={(v) => handleChange("name", v)}
          />
        </div>

        <FormInput
          label="Description"
          name="description"
          value={form.description}
          onChange={(v) => handleChange("description", v)}
        />

        <FormInput
          label="Season"
          name="season"
          value={form.season}
          onChange={(v) => handleChange("season", v)}
        />

        <FormCurrencyInput
          label="Retail Price"
          name="baseRetail"
          value={form.baseRetail}
          onChange={(v) => handleChange("baseRetail", v)}
        />

        <div className="mt-4">
          <label className="mb-1 block text-xs text-sh-gray">Service Type</label>
          <select
            value={form.serviceType}
            onChange={(e) => handleChange("serviceType", e.target.value)}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-sh-gold focus:outline-none"
          >
            <option value="">None (not a service product)</option>
            <option value="MEASURE">Measure</option>
            <option value="INSTALL">Install</option>
            <option value="DELIVERY">Delivery</option>
            <option value="HOUSE_CALL">House Call</option>
          </select>
        </div>

        <h3 className="text-lg font-serif text-sh-black mt-6 mb-2">Dimensions (inches)</h3>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <FormInput
            label="Length"
            name="length"
            value={form.length}
            onChange={(v) => handleChange("length", v)}
          />
          <FormInput
            label="Depth"
            name="depth"
            value={form.depth}
            onChange={(v) => handleChange("depth", v)}
          />
          <FormInput
            label="Height"
            name="height"
            value={form.height}
            onChange={(v) => handleChange("height", v)}
          />
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" onClick={handlePrint}>
            Print Label
          </Button>
          <Button variant="primary" onClick={handleSave}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
