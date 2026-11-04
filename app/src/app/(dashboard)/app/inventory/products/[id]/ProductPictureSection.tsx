"use client";

// /app/src/app/(dashboard)/app/inventory/products/[id]/ProductPictureSection.tsx
//
// GAP-07: the product's picture, which prints beside its lines on the invoice
// (lib/sales/linePicture.ts). A photo uploaded here, or the line drawing a
// price-list import extracted. Whoever edits the catalog (catalog.write)
// uploads, replaces or removes it through /api/products/[id]/picture.

import { useRef, useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/toastError";

interface Props {
  productId: number;
  name: string;
  imageUrl: string | null | undefined;
  canEdit: boolean;
  onChanged: () => void;
}

export function ProductPictureSection({
  productId,
  name,
  imageUrl,
  canEdit,
  onChanged,
}: Readonly<Props>) {
  const input = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  if (!imageUrl && !canEdit) return null;

  const url = `/api/products/${encodeURIComponent(String(productId))}/picture`;
  const uploadLabel = imageUrl ? "Replace" : "Upload";
  const send = async (request: () => Promise<unknown>, done: string) => {
    setSaving(true);
    try {
      await request();
      toast.success(done);
      onChanged();
    } catch (err) {
      toast.error(getErrorMessage(err, "Couldn't save the picture."));
    } finally {
      setSaving(false);
      if (input.current) input.current.value = "";
    }
  };

  const upload = (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return send(() => axios.post(url, form), "Picture saved.");
  };

  return (
    <div className="bg-white p-6 rounded-lg shadow-md mb-6">
      <h2 className="text-xl font-semibold mb-1">Picture</h2>
      <p className="mb-3 text-xs text-brand-gray">
        Printed beside this item on invoices and quotes.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- an uploaded file of any size, served from /uploads; next/image would need each one's dimensions
          <img
            src={imageUrl}
            alt={name}
            className="h-32 w-32 rounded border border-brand-gray/20 object-contain"
          />
        ) : (
          <p className="text-sm text-brand-gray">No picture yet.</p>
        )}
        {canEdit && (
          <div className="flex gap-2">
            <input
              ref={input}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              aria-label={`Picture of ${name}`}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => input.current?.click()}
            >
              {saving ? "Saving..." : uploadLabel}
            </Button>
            {imageUrl && (
              <Button
                size="sm"
                variant="secondary"
                disabled={saving}
                onClick={() => send(() => axios.delete(url), "Picture removed.")}
              >
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
