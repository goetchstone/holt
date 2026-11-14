// /app/src/components/products/MasterProductSelector.tsx
//
// Create Variant's master-product picker. It searches /api/products as you type
// (useProductSearch, as New Quote, POS and New Transfer do). It used to load
// one dropdown from /api/products?all=true, but that route pages and has no
// `all`, so the dropdown held the first 10 products by name and nothing else.

"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import FormInput from "@/components/form/FormInput";
import { useFetchOptions } from "@/hooks/useFetchOptions";
import { useProductSearch } from "@/hooks/useProductSearch";
import { toast } from "react-toastify";

// Define the Product type as expected from /api/products
type Product = {
  id: number;
  name: string;
  productNumber: string;
  vendorId: number;
  departmentId: number;
  categoryId: number;
  typeId?: number | null;
  retailPrice?: number | null;
  cost?: number | null;
  vendorName?: string;
  departmentName?: string;
  categoryName?: string;
  typeName?: string;
};

// Props for the MasterProductSelector component
type MasterProductSelectorProps = {
  selectedProductId: string;
  onSelectProduct: (product: Product | null) => void;
  onSelectedProductIdChange: (id: string) => void;
  selectedProduct: Product | null;
};

export default function MasterProductSelector({
  selectedProductId,
  onSelectProduct,
  onSelectedProductIdChange,
  selectedProduct,
}: MasterProductSelectorProps) {
  const [isCreatingNewMaster, setIsCreatingNewMaster] = useState(false);
  const [saving, setSaving] = useState(false); // For master product creation save status

  // Search master products server-side as the user types.
  const {
    query: productSearch,
    setQuery: setProductSearch,
    results: productResults,
    status: searchStatus,
    clear: clearProductSearch,
  } = useProductSearch({ limit: 20 });

  const chooseProduct = (product: Product | null) => {
    onSelectedProductIdChange(product ? String(product.id) : "");
    onSelectProduct(product);
    clearProductSearch();
  };

  // State for new master product creation form
  const [newMasterForm, setNewMasterForm] = useState({
    name: "",
    productNumber: "",
    vendorId: "",
    departmentId: "",
    categoryId: "",
  });

  // Options for new master product form dropdowns
  const [vendors] = useFetchOptions("/api/vendors?all=true");
  const [departments] = useFetchOptions("/api/departments?all=true");
  const [allCategories] = useFetchOptions("/api/categories?all=true");

  // Filter categories for the new master product form based on selected department
  const filteredCategories = useMemo(() => {
    if (newMasterForm.departmentId && allCategories.length > 0) {
      return allCategories.filter(
        (c) => c.departmentId === Number.parseInt(newMasterForm.departmentId),
      );
    }
    return [];
  }, [newMasterForm.departmentId, allCategories]);

  const handleNewMasterChange = (name: string, value: string | boolean) => {
    setNewMasterForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleCreateMasterProduct = async () => {
    // Basic validation for new master product
    if (
      !newMasterForm.name ||
      !newMasterForm.productNumber ||
      !newMasterForm.vendorId ||
      !newMasterForm.departmentId ||
      !newMasterForm.categoryId
    ) {
      toast.error("Master product name, number, vendor, department, and category are required.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        ...newMasterForm,
        vendorId: Number.parseInt(newMasterForm.vendorId),
        departmentId: Number.parseInt(newMasterForm.departmentId),
        categoryId: Number.parseInt(newMasterForm.categoryId),
        cost: "0", // Default cost
        retail: "0", // Default retail
      };
      const res = await fetch("/api/products/basic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const result = await res.json();
        toast.success("Master Product created!");
        // Select the new master as it was just saved, so its variants can be
        // entered straight away.
        const nameOf = (list: { id: string | number; name?: string }[], id: number) =>
          list.find((o) => Number(o.id) === id)?.name;
        chooseProduct({
          id: result.productId,
          name: payload.name,
          productNumber: payload.productNumber,
          vendorId: payload.vendorId,
          departmentId: payload.departmentId,
          categoryId: payload.categoryId,
          vendorName: nameOf(vendors, payload.vendorId),
          departmentName: nameOf(departments, payload.departmentId),
          categoryName: nameOf(allCategories, payload.categoryId),
        });
        setIsCreatingNewMaster(false); // Hide the master creation form
      } else {
        const errorData = await res.json();
        toast.error(`Failed to create Master Product: ${errorData.error || "Unknown error"}`);
      }
    } catch {
      toast.error("Error creating Master Product.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-8 border p-4 rounded-lg bg-brand-linen">
      <h2 className="text-xl font-serif text-brand-black mb-4">Master Product</h2>
      {!isCreatingNewMaster ? (
        // Find an existing master product
        <div className="flex items-start gap-4">
          <label
            htmlFor="masterProductSearch"
            className="font-serif text-brand-black mb-1 block min-w-[120px] pt-2"
          >
            Select Existing:
          </label>
          <div className="relative w-full">
            <input
              id="masterProductSearch"
              type="text"
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              placeholder={
                selectedProductId
                  ? "Search to choose a different master product..."
                  : "Search by name or product number..."
              }
              autoComplete="off"
              className="border p-2 rounded w-full"
            />
            {/* "No matching products." only once a search for exactly this
                text has come back; until then (debounce window or request
                out) the held results answer older text, so none are offered. */}
            {searchStatus !== "idle" && (
              <div className="absolute z-10 mt-1 w-full bg-white border border-brand-gray/20 rounded shadow-lg max-h-64 overflow-y-auto">
                {searchStatus === "searching" && (
                  <div className="px-3 py-2 text-sm text-brand-gray">Searching...</div>
                )}
                {searchStatus === "done" && productResults.length === 0 && (
                  <div className="px-3 py-2 text-sm text-brand-gray">No matching products.</div>
                )}
                {searchStatus === "done" &&
                  productResults.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => chooseProduct(p as unknown as Product)}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-brand-stripe border-b border-brand-gray/10 min-h-[44px]"
                    >
                      <span className="text-brand-black">{p.name}</span>
                      <span className="text-brand-gray ml-2">{p.productNumber}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
          {selectedProductId && (
            <Button type="button" variant="secondary" onClick={() => chooseProduct(null)}>
              Clear
            </Button>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => setIsCreatingNewMaster(true)}
            className="min-w-[150px]"
          >
            + Create New Master
          </Button>
        </div>
      ) : (
        // Create New Master Product Form
        <div className="space-y-4">
          <h3 className="text-lg font-serif text-brand-blue">Create New Master Product</h3>
          <div className="grid grid-cols-2 gap-4">
            <FormInput
              label="Product Name"
              name="name"
              value={newMasterForm.name}
              onChange={(v) => handleNewMasterChange("name", v)}
              required
            />
            <FormInput
              label="Product Number (SKU)"
              name="productNumber"
              value={newMasterForm.productNumber}
              onChange={(v) => handleNewMasterChange("productNumber", v)}
              required
            />
            <select
              value={newMasterForm.vendorId}
              onChange={(e) => handleNewMasterChange("vendorId", e.target.value)}
              className="border p-2 w-full"
              required
            >
              <option value="">Select Vendor</option>
              {(vendors || []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
            <select
              value={newMasterForm.departmentId}
              onChange={(e) => handleNewMasterChange("departmentId", e.target.value)}
              className="border p-2 w-full"
              required
            >
              <option value="">Select Department</option>
              {(departments || []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <select
              value={newMasterForm.categoryId}
              onChange={(e) => handleNewMasterChange("categoryId", e.target.value)}
              className="border p-2 w-full"
              required
            >
              <option value="">Select Category</option>
              {(filteredCategories || []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setIsCreatingNewMaster(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleCreateMasterProduct}
              disabled={saving}
            >
              {saving ? "Creating..." : "Create Master Product"}
            </Button>
          </div>
        </div>
      )}
      {selectedProduct && (
        <div className="mt-4 p-3 border rounded bg-white">
          <h3 className="text-lg font-semibold text-brand-blue">
            {selectedProduct.name} ({selectedProduct.productNumber})
          </h3>
          <p className="text-sm text-brand-black">
            Vendor: {selectedProduct.vendorName || "N/A"} | Dept:{" "}
            {selectedProduct.departmentName || "N/A"} | Cat: {selectedProduct.categoryName || "N/A"}
          </p>
        </div>
      )}
    </div>
  );
}
