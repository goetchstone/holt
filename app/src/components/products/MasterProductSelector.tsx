// /app/src/components/products/MasterProductSelector.tsx

"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import FormInput from "@/components/form/FormInput";
import { useFetchOptions } from "@/hooks/useFetchOptions";
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

  // Fetch all products (master items) for the dropdown
  const [products, loadingProducts, errorProducts] = useFetchOptions("/api/products?all=true");

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
        onSelectedProductIdChange(result.productId.toString()); // Select the newly created master product by its ID
        setIsCreatingNewMaster(false); // Hide the master creation form

        // If you want to force the 'products' dropdown to refresh and include the new master product:
        // You would need a mechanism in useFetchOptions to trigger a re-fetch,
        // or a manual re-fetch of products list here if it's critical.
        // For simplicity, relying on the user to re-open the page or select will work for now.
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

  // Display loading or error states for the main products dropdown
  if (loadingProducts) {
    return <div className="p-6 text-center text-sh-black font-serif">Loading products...</div>;
  }

  if (errorProducts) {
    return (
      <div className="p-6 text-center text-red-600 font-serif">
        Error loading products: {errorProducts.message}
      </div>
    );
  }

  return (
    <div className="mb-8 border p-4 rounded-lg bg-sh-linen">
      <h2 className="text-xl font-serif text-sh-black mb-4">Master Product</h2>
      {!isCreatingNewMaster ? (
        // Select Existing Master Product Form
        <div className="flex items-center gap-4">
          <label
            htmlFor="masterProductSelect"
            className="font-serif text-sh-black mb-1 block min-w-[120px]"
          >
            Select Existing:
          </label>
          <select
            id="masterProductSelect"
            value={selectedProductId}
            onChange={(e) => {
              const id = e.target.value;
              onSelectedProductIdChange(id);
              const product = products.find((p) => p.id === Number.parseInt(id));
              if (product) {
                onSelectProduct(product as Product);
              } else {
                onSelectProduct(null);
              }
            }}
            className="border p-2 rounded w-full"
          >
            <option value="">-- Select a Master Product --</option>
            {(products || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.productNumber})
              </option>
            ))}
          </select>
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
          <h3 className="text-lg font-serif text-sh-blue">Create New Master Product</h3>
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
          <h3 className="text-lg font-semibold text-sh-blue">
            {selectedProduct.name} ({selectedProduct.productNumber})
          </h3>
          <p className="text-sm text-sh-black">
            Vendor: {selectedProduct.vendorName || "N/A"} | Dept:{" "}
            {selectedProduct.departmentName || "N/A"} | Cat: {selectedProduct.categoryName || "N/A"}
          </p>
        </div>
      )}
    </div>
  );
}
