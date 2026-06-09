// /app/src/components/form/TypeFilter.tsx

"use client";

export default function TypeFilter({
  value,
  onChange,
  types, // This prop is now defensively mapped
  categoryId,
}: {
  value: string;
  onChange: (value: string) => void;
  types: any[]; // Expects an array, but we'll add defensive mapping
  categoryId: string;
}) {
  return (
    <div>
      <label className="font-serif text-sh-black mb-1 block">Type</label>
      <select
        name="typeId"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border p-2 w-full"
      >
        <option value="">No Type</option>
        {/* CORRECTED: Add defensive check before mapping */}
        {(types || []).map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </div>
  );
}
