// /app/src/components/pipeline/PipelineFilterBar.tsx

import { useState } from "react";
import { useMoneyFormatter } from "@/components/branding/BrandingProvider";
import type { ClientProfileChoices } from "@/lib/clientProfile";
import { SlidersHorizontal } from "lucide-react";
import {
  CLIENT_FILTERS,
  countActiveFilters,
  DEFAULT_PIPELINE_FILTERS,
  FOLLOW_UP_FILTERS,
  ODDS_FILTERS,
  PIPELINE_SORTS,
  profileFilters,
  QUOTE_TYPE_FILTERS,
  TIER_FILTERS,
  valueFilters,
  type PipelineFilters,
} from "@/lib/pipelineFilters";

const SELECT_CLASS =
  "w-full rounded-lg border border-brand-gray/30 bg-white px-3 py-2 text-sm text-brand-black min-h-[44px] focus:border-brand-blue focus:outline-none";

type FilterOption = { value: string; label: string };

function FilterSelect({
  label,
  options,
  value,
  onChange,
}: Readonly<{
  label: string;
  options: readonly FilterOption[];
  value: string;
  onChange: (next: string) => void;
}>) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={SELECT_CLASS}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export function PipelineFilterBar({
  filters,
  onChange,
  storeOptions,
  choices,
  shownCount,
  totalCount,
}: Readonly<{
  filters: PipelineFilters;
  onChange: (next: PipelineFilters) => void;
  storeOptions: FilterOption[];
  choices: ClientProfileChoices;
  shownCount: number;
  totalCount: number;
}>) {
  const [open, setOpen] = useState(false);
  const money = useMoneyFormatter();
  const activeCount = countActiveFilters(filters);
  const fromChoices = profileFilters(choices);

  function set(key: keyof PipelineFilters) {
    return (value: string) => onChange({ ...filters, [key]: value });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="inline-flex items-center gap-2 rounded-lg border border-brand-gray/30 px-4 min-h-[44px] text-sm font-semibold text-brand-blue hover:bg-brand-linen transition-colors"
        >
          <SlidersHorizontal className="w-4 h-4" />
          Filters
          {activeCount > 0 && (
            <span className="rounded-full bg-brand-blue text-white text-xs px-2 py-0.5">
              {activeCount}
            </span>
          )}
        </button>
        <div className="w-52">
          <FilterSelect
            label="Sort quotes"
            options={PIPELINE_SORTS}
            value={filters.sort}
            onChange={set("sort")}
          />
        </div>
        {activeCount > 0 && (
          <>
            <p className="text-xs text-brand-gray">
              Showing {shownCount} of {totalCount}
            </p>
            <button
              type="button"
              onClick={() => onChange({ ...DEFAULT_PIPELINE_FILTERS, sort: filters.sort })}
              className="text-xs font-semibold text-brand-blue hover:underline min-h-[44px] px-2"
            >
              Clear filters
            </button>
          </>
        )}
      </div>

      {open && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
          <FilterSelect
            label="Follow-up"
            options={FOLLOW_UP_FILTERS}
            value={filters.followUp}
            onChange={set("followUp")}
          />
          <FilterSelect
            label="Store"
            options={storeOptions}
            value={filters.store}
            onChange={set("store")}
          />
          <FilterSelect
            label="Lead tier"
            options={TIER_FILTERS}
            value={filters.tier}
            onChange={set("tier")}
          />
          <FilterSelect
            label="Client"
            options={CLIENT_FILTERS}
            value={filters.client}
            onChange={set("client")}
          />
          <FilterSelect
            label="Quote value"
            options={valueFilters((n) => money(n, { whole: true }))}
            value={filters.value}
            onChange={set("value")}
          />
          <FilterSelect
            label="Quote type"
            options={QUOTE_TYPE_FILTERS}
            value={filters.quoteType}
            onChange={set("quoteType")}
          />
          <FilterSelect
            label="Timeline"
            options={fromChoices.timeline}
            value={filters.timeline}
            onChange={set("timeline")}
          />
          <FilterSelect
            label="Closing odds"
            options={ODDS_FILTERS}
            value={filters.odds}
            onChange={set("odds")}
          />
          <FilterSelect
            label="Residence"
            options={fromChoices.residence}
            value={filters.residence}
            onChange={set("residence")}
          />
          <FilterSelect
            label="Room of interest"
            options={fromChoices.room}
            value={filters.room}
            onChange={set("room")}
          />
        </div>
      )}
    </div>
  );
}
