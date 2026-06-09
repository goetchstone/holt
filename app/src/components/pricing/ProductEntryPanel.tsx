// /app/src/components/pricing/ProductEntryPanel.tsx
//
// Inline the POS-ready product data section for the configurator Summary tab.
// Renders as a compact 2-column grid with copy buttons. Full description is
// collapsed by default behind a disclosure toggle to save vertical space.

import { useState, useCallback } from "react";
import { Copy, Check, ClipboardList, ChevronDown, ChevronRight } from "lucide-react";
import type { ProductEntryData } from "@/lib/pricing/productEntryMapping";

interface Props {
  data: ProductEntryData;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = value;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }, [value]);

  return (
    <button
      onClick={handleCopy}
      title={`Copy ${label}`}
      className="flex-shrink-0 p-1 rounded hover:bg-sh-linen transition-colors min-w-[24px] min-h-[24px] flex items-center justify-center"
    >
      {copied ? (
        <Check className="w-3 h-3 text-green-600" />
      ) : (
        <Copy className="w-3 h-3 text-sh-gray" />
      )}
    </button>
  );
}

function CompactField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1 min-w-0">
      <div className="min-w-0 flex-1">
        <span className="text-[10px] uppercase tracking-wider text-sh-gray font-sans">
          {label}:{" "}
        </span>
        <span className="text-xs text-sh-black font-serif">{value}</span>
      </div>
      <CopyButton value={value} label={label} />
    </div>
  );
}

export default function ProductEntryPanel({ data }: Props) {
  const [allCopied, setAllCopied] = useState(false);
  const [descOpen, setDescOpen] = useState(false);

  const handleCopyAll = useCallback(async () => {
    const block = [
      `Product Name: ${data.productName}`,
      `SKU: ${data.sku}`,
      `Supplier: ${data.supplier}`,
      `Selling Price: $${data.sellingPrice}`,
      `Description: ${data.description}`,
      `Department: ${data.department}`,
      `Category: ${data.category}`,
      `Stock Type: ${data.stockType}`,
      "",
      "--- Full Description (Screen 2) ---",
      data.fullDescription,
    ].join("\n");

    try {
      await navigator.clipboard.writeText(block);
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = block;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 2000);
    }
  }, [data]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs uppercase tracking-wider text-sh-gray font-sans font-semibold">
          Product Entry
        </h3>
        <button
          onClick={handleCopyAll}
          className="flex items-center gap-1 text-xs text-sh-blue hover:text-sh-navy transition-colors px-2 py-1 rounded hover:bg-sh-linen min-h-[32px]"
        >
          {allCopied ? (
            <>
              <Check className="w-3 h-3 text-green-600" />
              <span className="text-green-600">Copied</span>
            </>
          ) : (
            <>
              <ClipboardList className="w-3 h-3" />
              <span>Copy All</span>
            </>
          )}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <CompactField label="Product Name" value={data.productName} />
        <CompactField label="SKU" value={data.sku} />
        <CompactField label="Supplier" value={data.supplier} />
        <CompactField label="Selling Price" value={`$${data.sellingPrice}`} />
        <CompactField label="Department" value={data.department} />
        <CompactField label="Category" value={data.category} />
        {data.stockType && <CompactField label="Stock Type" value={data.stockType} />}
      </div>

      {/* Collapsible full description for the POS screen 2 */}
      <div className="mt-2">
        <button
          onClick={() => setDescOpen(!descOpen)}
          className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-sh-gray font-sans hover:text-sh-blue transition-colors"
        >
          {descOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          Full Description (Screen 2)
        </button>
        {descOpen && (
          <div className="mt-1 flex items-start gap-1">
            <pre className="flex-1 text-xs text-sh-black font-serif whitespace-pre-wrap bg-sh-linen/50 rounded p-2 leading-relaxed">
              {data.fullDescription}
            </pre>
            <CopyButton value={data.fullDescription} label="Full Description" />
          </div>
        )}
      </div>
    </div>
  );
}
