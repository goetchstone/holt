"use client";

// /app/src/app/(dashboard)/app/inventory/products/create-variant/CreateVariantView.tsx
//
// Simple Variant Product Entry body. App Router port of the legacy
// inventory/products/create-variant body (minus MainLayout chrome, which the
// (dashboard) layout supplies). Reads + writes the shared
// /api/products/:id/variants REST endpoints, which stay REST. SKU/description
// derivation, add/remove rows, and save (POST new + PUT existing) preserved.

import { useState, useEffect, useCallback } from "react";
import { toast } from "react-toastify";
import MasterProductSelector from "@/components/products/MasterProductSelector";
import VariantTable from "@/components/products/VariantTable";
import { generateBarcode } from "@/lib/barcode";
import { getErrorMessage } from "@/lib/toastError";

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

type ProductVariant = {
  id?: number | null;
  size: string;
  color: string;
  sku: string;
  upc: string;
  width: string;
  length: string;
  height: string;
  cost: string;
  msrp: string;
  retail: string;
  calculatedDescription?: string;
};

interface ApiVariant {
  id?: number | null;
  size: string;
  color: string;
  sku: string;
  upc: string;
  width: number | null;
  length: number | null;
  height: number | null;
  cost: number | null;
  msrp: number | null;
  retail: number | null;
}

const numToInput = (n: number | null | undefined): string => n?.toString() || "";

export function CreateVariantView() {
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [saving, setSaving] = useState(false);

  const calculateVariantDescription = useCallback(
    (productName: string, size: string, color: string): string => {
      let desc = productName;
      if (size) desc += `, Size: ${size}`;
      if (color) desc += `, Color: ${color}`;
      return desc;
    },
    [],
  );

  const calculateVariantSku = useCallback(
    (baseSku: string, size: string, color: string): string => {
      let sku = baseSku;
      if (size) sku += `-${size}`;
      if (color) sku += `-${color}`;
      return sku.toUpperCase();
    },
    [],
  );

  const loadVariants = useCallback(async () => {
    if (!selectedProduct?.id) {
      setVariants([]);
      return;
    }
    try {
      const res = await fetch(`/api/products/${selectedProduct.id}/variants`);
      if (!res.ok) {
        toast.error("Failed to load existing variants.");
        setVariants([]);
        return;
      }
      const data: ApiVariant[] = await res.json();
      setVariants(
        data.map((v) => ({
          ...v,
          calculatedDescription: calculateVariantDescription(selectedProduct.name, v.size, v.color),
          width: numToInput(v.width),
          length: numToInput(v.length),
          height: numToInput(v.height),
          cost: numToInput(v.cost),
          msrp: numToInput(v.msrp),
          retail: numToInput(v.retail),
        })),
      );
    } catch {
      toast.error("Error loading existing variants.");
      setVariants([]);
    }
  }, [selectedProduct, calculateVariantDescription]);

  useEffect(() => {
    loadVariants();
  }, [loadVariants]);

  const handleVariantChange = useCallback(
    (index: number, field: keyof ProductVariant, value: string) => {
      setVariants((prevVariants) => {
        const newVariants = [...prevVariants];
        const variantToUpdate = { ...newVariants[index], [field]: value };
        newVariants[index] = variantToUpdate;

        if (selectedProduct && (field === "size" || field === "color")) {
          const baseSku = selectedProduct.productNumber;
          const newSize = variantToUpdate.size;
          const newColor = variantToUpdate.color;

          newVariants[index].sku = calculateVariantSku(baseSku, newSize, newColor);
          newVariants[index].calculatedDescription = calculateVariantDescription(
            selectedProduct.name,
            newSize,
            newColor,
          );
        }
        return newVariants;
      });
    },
    [selectedProduct, calculateVariantSku, calculateVariantDescription],
  );

  const handleAddVariantRow = useCallback(() => {
    if (!selectedProduct) {
      toast.error("Please select or create a Master Product first to add variants.");
      return;
    }
    const newRow: ProductVariant = {
      size: "",
      color: "",
      sku: "",
      upc: "",
      width: "",
      length: "",
      height: "",
      cost: "",
      msrp: "",
      retail: "",
      calculatedDescription: calculateVariantDescription(selectedProduct.name, "", ""),
    };
    setVariants((prev) => [...prev, newRow]);
  }, [selectedProduct, calculateVariantDescription]);

  const deleteExistingVariant = useCallback(
    async (variantId: number, index: number) => {
      try {
        const res = await fetch(
          `/api/products/${selectedProduct?.id}/variants?variantId=${variantId}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.error || errorData.message || "Unknown error");
        }
        toast.success("Variant deleted from database.");
        setVariants((prev) => prev.filter((_, i) => i !== index));
      } catch (err: unknown) {
        toast.error(getErrorMessage(err, "Error deleting variant from database."));
      }
    },
    [selectedProduct],
  );

  const handleRemoveVariantRow = useCallback(
    (index: number) => {
      const variantToRemove = variants[index];
      if (variantToRemove.id) {
        const confirmed = confirm(
          "This variant exists in the database. Are you sure you want to delete it?",
        );
        if (!confirmed) return;
        deleteExistingVariant(variantToRemove.id, index);
      } else {
        setVariants((prev) => prev.filter((_, i) => i !== index));
      }
    },
    [variants, deleteExistingVariant],
  );

  const handleSaveVariants = async () => {
    if (!selectedProduct?.id) {
      toast.error("No Master Product selected to save variants for.");
      return;
    }

    setSaving(true);
    try {
      const variantsToSave = variants
        .map((v) => {
          const finalUpc = v.upc || generateBarcode(selectedProduct.vendorId, selectedProduct.id);
          return {
            id: v.id,
            productId: selectedProduct.id,
            size: v.size || null,
            color: v.color || null,
            sku: v.sku || null,
            upc: finalUpc,
            width: Number.parseFloat(v.width || "0") || null,
            length: Number.parseFloat(v.length || "0") || null,
            height: Number.parseFloat(v.height || "0") || null,
            cost: Number.parseFloat(v.cost || "0") || null,
            msrp: Number.parseFloat(v.msrp || "0") || null,
            retail: Number.parseFloat(v.retail || "0") || null,
          };
        })
        .filter((v) => v.size || v.color || v.sku || v.id);

      const newVariants = variantsToSave.filter((v) => !v.id);
      const existingVariants = variantsToSave.filter((v) => v.id);

      if (newVariants.length > 0) {
        const res = await fetch(`/api/products/${selectedProduct.id}/variants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(newVariants),
        });
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(
            `Failed to create some variants: ${errorData.error || errorData.message || "Unknown error"}`,
          );
        }
      }

      if (existingVariants.length > 0) {
        const res = await fetch(`/api/products/${selectedProduct.id}/variants`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(existingVariants),
        });
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(
            `Failed to update some variants: ${errorData.error || errorData.message || "Unknown error"}`,
          );
        }
      }

      toast.success("Variants saved successfully!");
      setSelectedProduct((prev) => (prev ? { ...prev } : null));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Error saving variants."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-serif text-sh-blue mb-6">
        Simple Variant Product Entry (Apparel, Case Goods)
      </h1>

      <MasterProductSelector
        selectedProductId={selectedProductId}
        onSelectedProductIdChange={setSelectedProductId}
        selectedProduct={selectedProduct}
        onSelectProduct={setSelectedProduct}
      />

      {selectedProduct && (
        <VariantTable
          variants={variants}
          selectedProduct={selectedProduct}
          onVariantChange={handleVariantChange}
          onAddVariantRow={handleAddVariantRow}
          onRemoveVariantRow={handleRemoveVariantRow}
          onSaveVariants={handleSaveVariants}
          saving={saving}
        />
      )}
    </div>
  );
}
