// /app/src/components/form/CategoryFilter.tsx

"use client";

export default function CategoryFilter({
  value,
  onChange,
  categories, // This prop is now defensively mapped
}: {
  value: string;
  onChange: (value: string) => void;
  categories: any[]; // Expects an array, but we'll add defensive mapping
}) {
  return (
    <div>
      <label className="font-serif text-sh-black mb-1 block">Category</label>
      <select
        name="categoryId"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border p-2 w-full"
        required
      >
        <option value="">Select Category</option>
        {/* CORRECTED: Add defensive check before mapping */}
        {(categories || []).map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
