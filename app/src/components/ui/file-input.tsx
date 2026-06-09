// /app/src/components/ui/file-input.tsx

import { ChangeEvent } from "react";
import clsx from "clsx";

interface FileInputProps {
  label: string;
  accept: string;
  onChange: (file: File | null) => void;
  className?: string;
}

export function FileInput({ label, accept, onChange, className }: FileInputProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    onChange(file);
  };

  return (
    <div className={clsx("flex flex-col", className)}>
      <label className="text-sm font-medium text-sh-black mb-1">{label}</label>
      <input
        type="file"
        accept={accept}
        onChange={handleChange}
        className="block w-full text-sm text-sh-black
                   file:mr-4 file:py-2 file:px-4
                   file:rounded-full file:border-0
                   file:text-sm file:font-semibold
                   file:bg-sh-blue file:text-white
                   hover:file:bg-sh-black"
      />
    </div>
  );
}
