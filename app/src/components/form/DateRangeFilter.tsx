// /app/src/components/form/DateRangeFilter.tsx
type DateRange = {
  startDate: string;
  endDate: string;
};

type DateRangeFilterProps = {
  value: DateRange;
  onChange: (value: DateRange) => void;
};

export default function DateRangeFilter({ value, onChange }: DateRangeFilterProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="font-serif text-sh-black">Date Range</label>
      <div className="flex gap-2">
        <div className="flex flex-col flex-1">
          <label className="text-xs text-sh-black">Start Date</label>
          <input
            type="date"
            value={value.startDate}
            onChange={(e) => onChange({ ...value, startDate: e.target.value })}
            className="border p-2 w-full"
          />
        </div>
        <div className="flex flex-col flex-1">
          <label className="text-xs text-sh-black">End Date</label>
          <input
            type="date"
            value={value.endDate}
            onChange={(e) => onChange({ ...value, endDate: e.target.value })}
            className="border p-2 w-full"
          />
        </div>
      </div>
    </div>
  );
}
