// /app/src/components/cms/admin/ImageUploadField.tsx
//
// Labeled image field: paste a URL or upload a file (POSTs to /api/cms/media,
// then fills the URL). Shows a small preview. Drop-in replacement for the plain
// text field wherever an image URL is edited (CMS blocks, branding settings).

"use client";

import { useRef, useState } from "react";
import { toast } from "react-toastify";
import { getErrorMessage } from "@/lib/toastError";

interface ImageUploadFieldProps {
  label: string;
  value: string;
  onChange: (url: string) => void;
  placeholder?: string;
}

export function ImageUploadField({ label, value, onChange, placeholder }: ImageUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function upload(file: File) {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/cms/media", { method: "POST", body });
      if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      const { asset } = await res.json();
      onChange(asset.url);
      toast.success("Image uploaded");
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Upload failed"));
    } finally {
      setUploading(false);
    }
  }

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-sh-gray">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          placeholder={placeholder ?? "/uploads/... or https://..."}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-md border border-black/15 px-3 py-2 text-sm focus:border-sh-navy focus:outline-none"
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="shrink-0 rounded-md border border-sh-navy/30 px-3 py-2 text-sm text-sh-navy transition hover:bg-sh-linen disabled:opacity-50"
        >
          {uploading ? "Uploading…" : "Upload"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = "";
          }}
        />
      </div>
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element -- preview of an arbitrary image URL
        <img
          src={value}
          alt=""
          className="mt-2 h-16 w-auto rounded border border-black/10 object-contain"
        />
      ) : null}
    </label>
  );
}
