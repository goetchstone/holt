"use client";

// /app/src/app/(dashboard)/app/inventory/products/create-basic/CreateBasicView.tsx
//
// Create Basic Item body. App Router port of the legacy
// inventory/products/create-basic body (minus MainLayout chrome, which the
// (dashboard) layout supplies). Reads /api/vendors, /api/departments,
// /api/categories, /api/types/by-category + writes /api/products/basic REST
// endpoints, which stay REST. Auto-markup, duplicate, and validation preserved.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import VendorFilter from "@/components/form/VendorFilter";
import DepartmentFilter from "@/components/form/DepartmentFilter";
import CategoryFilter from "@/components/form/CategoryFilter";
import TypeFilter from "@/components/form/TypeFilter";
import FormInput from "@/components/form/FormInput";
import FormCurrencyInput from "@/components/form/FormCurrencyInput";
import FormNumberInput from "@/components/form/FormNumberInput";
import { useFetchOptions } from "@/hooks/useFetchOptions";
import { getErrorMessage } from "@/lib/toastError";

interface BasicForm {
  name: string;
  productNumber: string;
  description: string;
  vendorId: string;
  departmentId: string;
  categoryId: string;
  typeId: string;
  season: string;
  cost: string;
  retail: string;
  width: string;
  depth: string;
  height: string;
  barcode: string;
}

const EMPTY_FORM: BasicForm = {
  name: "",
  productNumber: "",
  description: "",
  vendorId: "",
  departmentId: "",
  categoryId: "",
  typeId: "",
  season: "",
  cost: "",
  retail: "",
  width: "",
  depth: "",
  height: "",
  barcode: "",
};

type Option = { id: string | number; name?: string; [key: string]: unknown };

function buildPayload(form: BasicForm) {
  return {
    ...form,
    vendorId: Number.parseInt(form.vendorId),
    departmentId: Number.parseInt(form.departmentId),
    categoryId: Number.parseInt(form.categoryId),
    typeId: form.typeId ? Number.parseInt(form.typeId) : undefined,
    cost: Number.parseFloat(form.cost),
    retail: Number.parseFloat(form.retail),
    length: Number.parseFloat(form.width || "0") || undefined,
    depth: Number.parseFloat(form.depth || "0") || undefined,
    height: Number.parseFloat(form.height || "0") || undefined,
  };
}

function isPayloadValid(p: ReturnType<typeof buildPayload>): boolean {
  return Boolean(
    p.name &&
    p.productNumber &&
    !Number.isNaN(p.vendorId) &&
    !Number.isNaN(p.departmentId) &&
    !Number.isNaN(p.categoryId) &&
    !Number.isNaN(p.cost) &&
    !Number.isNaN(p.retail),
  );
}

export function CreateBasicView() {
  const router = useRouter();

  const [form, setForm] = useState<BasicForm>(EMPTY_FORM);
  const [autoMarkup] = useState<boolean>(true);

  const [vendors, loadingVendors, errorVendors] = useFetchOptions("/api/vendors?all=true");
  const [allCategories] = useFetchOptions("/api/categories?all=true");
  const [filteredCategories, setFilteredCategories] = useState<Option[]>([]);
  const [filteredTypes, setFilteredTypes] = useState<Option[]>([]);

  useEffect(() => {
    if (form.departmentId && allCategories.length > 0) {
      setFilteredCategories(
        allCategories.filter((c) => c.departmentId === Number.parseInt(form.departmentId)),
      );
    } else {
      setFilteredCategories([]);
      setForm((prev) => ({ ...prev, categoryId: "", typeId: "" }));
    }
  }, [form.departmentId, allCategories]);

  useEffect(() => {
    if (!form.categoryId) {
      setFilteredTypes([]);
      setForm((prev) => ({ ...prev, typeId: "" }));
      return;
    }
    fetch(`/api/types/by-category/${form.categoryId}`)
      .then((res) => res.json())
      .then((data) => setFilteredTypes(Array.isArray(data) ? data : []))
      .catch(() => {
        toast.error("Failed to load types.");
        setFilteredTypes([]);
      });
  }, [form.categoryId]);

  useEffect(() => {
    if (loadingVendors || errorVendors || vendors.length === 0) return;
    const selectedVendor = vendors.find((v) => v.id === Number.parseInt(form.vendorId));
    const vendorMarkup = (selectedVendor?.markupPercent as number | undefined) || 0;
    if (autoMarkup && form.cost) {
      const costValue = Number.parseFloat(form.cost);
      if (!Number.isNaN(costValue)) {
        const calculatedRetail = (costValue * (1 + vendorMarkup / 100)).toFixed(2);
        setForm((prev) => ({ ...prev, retail: calculatedRetail }));
      }
    }
  }, [form.vendorId, vendors, autoMarkup, form.cost, loadingVendors, errorVendors]);

  const handleChange = (name: string, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleCreateOrDuplicate = async (submitForm: BasicForm, isDuplicate: boolean) => {
    const payload = buildPayload(submitForm);
    if (!isPayloadValid(payload)) {
      toast.error(
        "Please fill in all required fields (Product Name, Product #, Vendor, Department, Category, Cost, Retail).",
      );
      return;
    }

    try {
      const res = await fetch("/api/products/basic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorData = await res.json();
        toast.error(`Operation failed: ${errorData.error || errorData.message || "Unknown error"}`);
        return;
      }

      if (isDuplicate) {
        toast.success("Item duplicated and created successfully!");
        // Clear Product # + Barcode so the next duplicate gets fresh identifiers.
        setForm((prev) => ({ ...prev, productNumber: "", barcode: "" }));
      } else {
        toast.success("Item created successfully!");
        router.push("/app/inventory/products");
      }
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "An unexpected error occurred during product operation."));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await handleCreateOrDuplicate(form, false);
  };

  const handleDuplicate = async () => {
    await handleCreateOrDuplicate(form, true);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-serif text-sh-blue mb-6">Create Basic Item</h1>
      <form onSubmit={handleSubmit} className="space-y-6 font-serif">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <VendorFilter value={form.vendorId} onChange={(v) => handleChange("vendorId", v)} />
          <DepartmentFilter
            value={form.departmentId}
            onChange={(v) => handleChange("departmentId", v)}
          />
          <CategoryFilter
            value={form.categoryId}
            onChange={(v) => handleChange("categoryId", v)}
            categories={filteredCategories}
          />
          <TypeFilter
            value={form.typeId}
            onChange={(v) => handleChange("typeId", v)}
            categoryId={form.categoryId}
            types={filteredTypes}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <FormInput
            label="Product Name"
            name="name"
            value={form.name}
            onChange={(v) => handleChange("name", v)}
            required
          />
          <FormInput
            label="Product Number (SKU)"
            name="productNumber"
            value={form.productNumber}
            onChange={(v) => handleChange("productNumber", v)}
            required
          />
          <FormInput
            label="Season (optional)"
            name="season"
            value={form.season}
            onChange={(v) => handleChange("season", v)}
          />
          <FormInput
            label="Barcode / UPC"
            name="barcode"
            value={form.barcode}
            onChange={(v) => handleChange("barcode", v)}
          />
        </div>

        <FormInput
          label="Description"
          name="description"
          value={form.description}
          onChange={(v) => handleChange("description", v)}
        />

        <h3 className="text-xl font-serif text-sh-black mt-8 mb-2">Dimensions (inches)</h3>
        <div className="grid grid-cols-3 gap-4">
          <FormNumberInput
            label="Width"
            name="width"
            value={form.width}
            onChange={(v) => handleChange("width", v)}
          />
          <FormNumberInput
            label="Depth"
            name="depth"
            value={form.depth}
            onChange={(v) => handleChange("depth", v)}
          />
          <FormNumberInput
            label="Height"
            name="height"
            value={form.height}
            onChange={(v) => handleChange("height", v)}
          />
        </div>

        <h3 className="text-xl font-serif text-sh-black mt-8 mb-2">Pricing</h3>
        <div className="grid grid-cols-2 gap-4">
          <FormCurrencyInput
            label="Cost"
            name="cost"
            value={form.cost}
            onChange={(v) => handleChange("cost", v)}
            required
          />
          <FormCurrencyInput
            label="Retail Price"
            name="retail"
            value={form.retail}
            onChange={(v) => handleChange("retail", v)}
            required
          />
        </div>

        <div className="flex justify-end gap-4 mt-6">
          {/* Duplicate button stays type="button" to avoid auto-submitting the form. */}
          <button
            type="button"
            onClick={handleDuplicate}
            className="bg-gray-400 text-white px-6 py-2 rounded-2xl shadow-md hover:bg-sh-black transition font-serif text-sm"
          >
            Duplicate Item
          </button>
          <button
            type="submit"
            className="bg-sh-blue text-white px-6 py-2 rounded-2xl shadow-md hover:bg-sh-black transition font-serif text-sm"
          >
            Create Item
          </button>
        </div>
      </form>
    </div>
  );
}
