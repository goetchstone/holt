// /app/src/components/form/FormDropdown.tsx

import { ChangeEvent } from "react";

type FormDropdownProps = {
  label: string;
  options: { id: string; name: string }[];
  value: string;
  onChange: (value: string) => void;
  onAddNew?: () => void;
  disabled?: boolean;
};

export default function FormDropdown({
  label,
  options,
  value,
  onChange,
  onAddNew,
  disabled = false,
}: FormDropdownProps) {
  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => {
    onChange(e.target.value);
  };

  return (
    <div className="mb-4">
      <label className="block text-sh-blue font-serif mb-1">{label}</label>
      <div className="flex items-center space-x-2">
        <select
          value={value}
          onChange={handleChange}
          disabled={disabled}
          className="w-full border border-sh-gray rounded-lg px-3 py-2 text-sh-black font-serif"
        >
          <option value="">Select {label}</option>
          {options.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {opt.name}
            </option>
          ))}
        </select>
        {onAddNew && (
          <button
            type="button"
            onClick={onAddNew}
            className="text-sm text-sh-blue font-serif border border-sh-blue rounded-lg px-3 py-2 hover:bg-sh-blue hover:text-white transition"
          >
            + Add New
          </button>
        )}
      </div>
    </div>
  );
}
