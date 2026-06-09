// /app/src/components/form/FormTextArea.tsx

type FormTextAreaProps = {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  required?: boolean; // Added 'required' prop
};

export default function FormTextArea({
  label,
  name,
  value,
  onChange,
  placeholder,
  rows = 4,
  required = false,
}: FormTextAreaProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="font-serif text-sh-black">
        {label}
      </label>
      <textarea
        id={name}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        required={required} // Pass the required prop down to the native textarea
        className="border p-2 w-full"
      />
    </div>
  );
}
