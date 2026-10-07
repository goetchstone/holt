// /app/src/components/form/FormInput.tsx

type FormInputProps = {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number";
  disabled?: boolean;
  placeholder?: string;
  required?: boolean; // Added 'required' prop
};

export default function FormInput({
  label,
  name,
  value,
  onChange,
  type = "text",
  disabled = false,
  placeholder = "",
  required = false, // Default to false if not provided
}: FormInputProps) {
  return (
    <div className="mb-4">
      <label htmlFor={name} className="block text-brand-blue font-serif mb-1">
        {label}
      </label>
      <input
        type={type}
        name={name}
        id={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        required={required} // Pass the required prop down to the native input
        className="w-full border border-brand-gray rounded-lg px-3 py-2.5 text-brand-black font-serif"
      />
    </div>
  );
}
