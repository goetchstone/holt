// /app/src/app/(dashboard)/app/admin/buyer-drafts/FilterDropdown.tsx
//
// Labelled <select> filter primitive for the buyer-drafts workbench. a11y:
// htmlFor + id pair derived from the label.

"use client";

interface FilterDropdownProps {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
}

export function FilterDropdown({ label, value, onChange, options }: Readonly<FilterDropdownProps>) {
  const id = `filter-${label.toLowerCase()}`;
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-sm font-semibold text-sh-navy">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="px-3 py-2 border border-sh-stripe rounded text-sm bg-white min-h-[36px]"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
