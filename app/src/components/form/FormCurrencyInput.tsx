// /app/src/components/form/FormCurrencyInput.tsx

type FormCurrencyInputProps = {
  label: string;
  name: string;
  value: number | string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean; // Added/Ensured disabled prop
  required?: boolean; // Added required prop
};

export default function FormCurrencyInput({
  label,
  name,
  value,
  onChange,
  placeholder,
  disabled,
  required,
}: FormCurrencyInputProps) {
  return (
    <div className="mb-4">
      <label htmlFor={name} className="block text-sh-blue font-serif mb-1">
        {label}
      </label>
      <div className="flex items-center border border-sh-gray rounded-lg px-3 py-2">
        <span className="text-sh-black mr-2 font-serif">$</span>
        <input
          id={name}
          name={name}
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          className="w-full outline-none font-serif text-sh-black"
        />
      </div>
    </div>
  );
}
