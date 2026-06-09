// /app/src/components/form/FormNumberInput.tsx

type FormNumberInputProps = {
  label: string;
  name: string;
  value: number | string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean; // Added disabled prop
};

export default function FormNumberInput({
  label,
  name,
  value,
  onChange,
  placeholder,
  disabled = false,
}: FormNumberInputProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="font-serif text-sh-black">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled} // Pass disabled prop
        className="border p-2 w-full"
      />
    </div>
  );
}
