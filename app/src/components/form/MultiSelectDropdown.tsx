// /app/src/components/form/MultiSelectDropdown.tsx
//
// Touch-friendly multi-select dropdown. Replaces walls of toggle chips
// when there are many options. The button shows a count when one or
// more are selected; the panel opens below with checkboxes + a
// "Clear all" affordance.
//
// Click / tap outside closes the panel. Designed for iPad first.
//
// Used by /reports/sales-by-salesperson.tsx for both the department
// and salesperson filters.

import { useEffect, useRef, useState } from "react";

export interface MultiSelectOption {
  value: string;
  label: string;
}

interface MultiSelectDropdownProps {
  readonly label: string;
  readonly options: readonly MultiSelectOption[];
  readonly selected: readonly string[];
  readonly onChange: (next: string[]) => void;
  /** Text shown on the button when nothing is selected. Defaults to "All <label>". */
  readonly emptyLabel?: string;
  /** Right-align the panel under the button. Useful when the button is on the right edge. */
  readonly align?: "left" | "right";
  /** Optional CSS width override for the panel. Defaults to ~18rem (w-72). */
  readonly panelClassName?: string;
}

export default function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  emptyLabel,
  align = "left",
  panelClassName,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent | TouchEvent) {
      const target = e.target as Node | null;
      if (ref.current && target && !ref.current.contains(target)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocPointer);
    document.addEventListener("touchstart", onDocPointer);
    return () => {
      document.removeEventListener("mousedown", onDocPointer);
      document.removeEventListener("touchstart", onDocPointer);
    };
  }, [open]);

  function toggle(value: string) {
    onChange(selected.includes(value) ? selected.filter((s) => s !== value) : [...selected, value]);
  }

  const buttonLabel =
    selected.length > 0
      ? `${label} (${selected.length})`
      : emptyLabel || `All ${label.toLowerCase()}`;

  const panelAlign = align === "right" ? "right-0" : "left-0";
  const panelWidth = panelClassName || "w-72";

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`px-3 py-2 text-sm rounded-lg border min-h-[42px] font-sans transition flex items-center gap-2 ${
          selected.length > 0
            ? "bg-sh-blue text-white border-sh-blue"
            : "bg-white text-sh-black border-sh-gray/30 hover:border-sh-blue"
        }`}
      >
        <span>{buttonLabel}</span>
        <svg
          className={`w-4 h-4 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div
          className={`absolute mt-1 ${panelAlign} ${panelWidth} bg-white border border-sh-gray/30 rounded-lg shadow-lg z-20 max-h-80 overflow-y-auto`}
        >
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="w-full text-left px-3 py-2 text-xs text-sh-blue hover:bg-sh-stripe border-b border-sh-gray/20"
            >
              Clear all ({selected.length})
            </button>
          )}
          {options.length === 0 ? (
            <p className="px-3 py-3 text-sm text-sh-gray italic">No options</p>
          ) : (
            <ul>
              {options.map((opt) => {
                const checked = selected.includes(opt.value);
                return (
                  <li key={opt.value}>
                    <label className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-sh-stripe min-h-[40px] text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(opt.value)}
                        className="h-4 w-4 accent-sh-blue"
                      />
                      <span className={checked ? "font-medium text-sh-black" : "text-sh-black"}>
                        {opt.label}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
