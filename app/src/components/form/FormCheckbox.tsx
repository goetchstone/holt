// /app/src/components/form/FormCheckbox.tsx

import { ChangeEvent } from "react";

type FormCheckboxProps = {
  label: string;
  name: string;
  checked: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
};

export default function FormCheckbox({
  label,
  name,
  checked,
  onChange,
  disabled = false,
}: FormCheckboxProps) {
  return (
    <div className="mb-4">
      <label className="flex items-center gap-2 text-sh-black font-serif">
        <input
          type="checkbox"
          name={name}
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          className="h-5 w-5 border border-sh-gray rounded accent-sh-blue"
        />
        {label}
      </label>
    </div>
  );
}
