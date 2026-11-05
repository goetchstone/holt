// /app/src/components/pipeline/NextFollowUpPicker.tsx

import { addDaysToCalendarDate, NEXT_FOLLOW_UP_CHOICES } from "@/lib/pipelineFollowUp";

const CHIP_BASE =
  "px-3 py-2 rounded-lg border text-xs font-semibold transition-colors min-h-[44px]";
const CHIP_ON = "bg-brand-blue text-white border-brand-blue";
const CHIP_OFF = "border-brand-gray/30 text-brand-gray hover:border-brand-blue";

export function NextFollowUpPicker({
  value,
  today,
  onChange,
}: Readonly<{
  value: string | null;
  today: string;
  onChange: (next: string | null) => void;
}>) {
  return (
    <div>
      <p className="text-xs text-brand-gray uppercase tracking-wide mb-2">Next follow-up</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onChange(null)}
          className={`${CHIP_BASE} ${value === null ? CHIP_ON : CHIP_OFF}`}
        >
          None
        </button>
        {NEXT_FOLLOW_UP_CHOICES.map((choice) => {
          const date = addDaysToCalendarDate(today, choice.days);
          return (
            <button
              key={choice.label}
              type="button"
              onClick={() => onChange(date)}
              className={`${CHIP_BASE} ${value === date ? CHIP_ON : CHIP_OFF}`}
            >
              {choice.label}
            </button>
          );
        })}
        <input
          type="date"
          value={value ?? ""}
          min={today}
          onChange={(e) => onChange(e.target.value || null)}
          aria-label="Next follow-up date"
          className="border border-brand-gray/30 rounded-lg px-3 py-2 text-sm text-brand-black min-h-[44px] focus:outline-none focus:ring-1 focus:ring-brand-blue"
        />
      </div>
    </div>
  );
}
