// /app/src/components/form/FormDatePicker.tsx

type FormDatePickerProps = {
  label: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
};

export default function FormDatePicker({ label, name, value, onChange }: FormDatePickerProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="font-serif text-sh-black">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border p-2 w-full"
      />
    </div>
  );
}
