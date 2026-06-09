// /app/src/components/products/VariantTable.tsx

"use client";

import { useCallback } from "react";
import { Button } from "@/components/ui/button";
import FormInput from "@/components/form/FormInput";
import FormCurrencyInput from "@/components/form/FormCurrencyInput";
import FormNumberInput from "@/components/form/FormNumberInput";

// Define types as they are used in the parent component and schema
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

// Props for the VariantTable component
type VariantTableProps = {
  variants: ProductVariant[];
  selectedProduct: Product | null;
  onVariantChange: (index: number, field: keyof ProductVariant, value: string) => void;
  onAddVariantRow: () => void;
  onRemoveVariantRow: (index: number) => void;
  onSaveVariants: () => Promise<void>;
  saving: boolean;
};

export default function VariantTable({
  variants,
  selectedProduct,
  onVariantChange,
  onAddVariantRow,
  onRemoveVariantRow,
  onSaveVariants,
  saving,
}: VariantTableProps) {
  // This component focuses on rendering the table and triggering parent callbacks.
  // Calculation logic is still in the parent (create-variant.tsx) to ensure dependencies on selectedProduct are managed there.

  return (
    <div className="mb-8">
      <h2 className="text-xl font-serif text-sh-black mb-4">
        Variants for {selectedProduct?.name || "Selected Product"}
      </h2>
      <Button
        type="button"
        onClick={onAddVariantRow}
        variant="secondary"
        className="mb-4"
        disabled={!selectedProduct}
      >
        + Add Variant Row
      </Button>

      <div className="overflow-x-auto border border-sh-gray rounded-lg shadow-sm">
        <table className="min-w-full text-left text-sm whitespace-nowrap table-auto">
          <thead className="bg-sh-linen text-sh-black">
            <tr>
              <th className="p-2 border-b border-sh-gray w-[20%]">Description</th>
              <th className="p-2 border-b border-sh-gray w-[10%]">Size</th>
              <th className="p-2 border-b border-sh-gray w-[10%]">Color</th>
              <th className="p-2 border-b border-sh-gray w-[15%]">SKU</th>
              <th className="p-2 border-b border-sh-gray w-[15%]">UPC/Barcode</th>
              <th className="p-2 border-b border-sh-gray w-[10%]">Cost</th>
              <th className="p-2 border-b border-sh-gray w-[10%]">MSRP</th>
              <th className="p-2 border-b border-sh-gray w-[10%]">Retail</th>
              <th className="p-2 border-b border-sh-gray w-[15%]">Dim (WxLxH)</th>
              <th className="p-2 border-b border-sh-gray w-[10%]">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(variants || []).map((variant, index) => (
              <tr
                key={variant.id || `new-${index}`}
                className="odd:bg-white even:bg-sh-stripe h-16"
              >
                <td className="p-2 border-b border-sh-gray truncate overflow-hidden">
                  {variant.calculatedDescription}
                </td>
                <td className="p-2 border-b border-sh-gray">
                  <FormInput
                    label=""
                    name={`size-${index}`}
                    value={variant.size}
                    onChange={(v) => onVariantChange(index, "size", v)}
                  />
                </td>
                <td className="p-2 border-b border-sh-gray">
                  <FormInput
                    label=""
                    name={`color-${index}`}
                    value={variant.color}
                    onChange={(v) => onVariantChange(index, "color", v)}
                  />
                </td>
                <td className="p-2 border-b border-sh-gray">
                  <FormInput
                    label=""
                    name={`sku-${index}`}
                    value={variant.sku}
                    onChange={(v) => onVariantChange(index, "sku", v)}
                  />
                </td>
                <td className="p-2 border-b border-sh-gray">
                  <FormInput
                    label=""
                    name={`upc-${index}`}
                    value={variant.upc}
                    onChange={(v) => onVariantChange(index, "upc", v)}
                    placeholder="Auto-generate"
                  />
                </td>
                <td className="p-2 border-b border-sh-gray">
                  <FormCurrencyInput
                    label=""
                    name={`cost-${index}`}
                    value={variant.cost}
                    onChange={(v) => onVariantChange(index, "cost", v)}
                  />
                </td>
                <td className="p-2 border-b border-sh-gray">
                  <FormCurrencyInput
                    label=""
                    name={`msrp-${index}`}
                    value={variant.msrp}
                    onChange={(v) => onVariantChange(index, "msrp", v)}
                  />
                </td>
                <td className="p-2 border-b border-sh-gray">
                  <FormCurrencyInput
                    label=""
                    name={`retail-${index}`}
                    value={variant.retail}
                    onChange={(v) => onVariantChange(index, "retail", v)}
                  />
                </td>
                <td className="p-2 border-b border-sh-gray">
                  <div className="flex gap-1">
                    <FormNumberInput
                      label=""
                      name={`width-${index}`}
                      value={variant.width}
                      onChange={(v) => onVariantChange(index, "width", v)}
                      placeholder="W"
                    />
                    <FormNumberInput
                      label=""
                      name={`length-${index}`}
                      value={variant.length}
                      onChange={(v) => onVariantChange(index, "length", v)}
                      placeholder="L"
                    />
                    <FormNumberInput
                      label=""
                      name={`height-${index}`}
                      value={variant.height}
                      onChange={(v) => onVariantChange(index, "height", v)}
                      placeholder="H"
                    />
                  </div>
                </td>
                <td className="p-2 border-b border-sh-gray">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => onRemoveVariantRow(index)}
                    className="text-red-600 border-red-600 hover:bg-red-50"
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
            {variants.length === 0 && (
              <tr>
                <td colSpan={10} className="p-4 text-center text-sh-gray">
                  Add variant rows below for this Master Product.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end mt-4">
        <Button
          type="button"
          onClick={onSaveVariants}
          disabled={saving || variants.length === 0}
          variant="primary"
        >
          {saving ? "Saving Variants..." : "Save All Variants"}
        </Button>
      </div>
    </div>
  );
}
