// /app/src/lib/pipelineFilters.ts
//
// The pipeline's filters and sorts. They run in the browser over quotes already loaded,
// under the API's 200-row cap. The choices a store sets for itself (timelines, residences,
// rooms) come in from AppSettings. The value bands are the same everywhere, and the screen
// words them in the store's currency.

import type { LeadTier } from "@/lib/leadScore";
import {
  clientInfoTexts,
  type ClientProfileChoices,
  type ClientProfileView,
} from "@/lib/clientProfile";
import { hasPurchased } from "@/lib/pipelineClient";
import { needsAttention, type FollowUpState } from "@/lib/pipelineFollowUp";

const ALL = "all";

function optionsFrom(values: readonly string[], allLabel: string) {
  return [{ value: ALL, label: allLabel }, ...values.map((value) => ({ value, label: value }))];
}

export const FOLLOW_UP_FILTERS = [
  { value: ALL, label: "All follow-ups" },
  { value: "attention", label: "Needs attention" },
  { value: "scheduled", label: "Scheduled" },
  { value: "noContact", label: "No contact yet" },
];

const LEAD_TIERS: readonly LeadTier[] = ["HOT", "WARM", "COOL", "NEW"];
export const TIER_FILTERS = optionsFrom(LEAD_TIERS, "All lead tiers");

export const CLIENT_FILTERS = [
  { value: ALL, label: "All clients" },
  { value: "past", label: "Past clients" },
  { value: "new", label: "New clients" },
];

/** The value bands, in the store's currency. */
export function valueFilters(money: (amount: number) => string) {
  return [
    { value: ALL, label: "Any value" },
    { value: "under2500", label: `Under ${money(2500)}` },
    { value: "2500to10000", label: `${money(2500)} to ${money(10000)}` },
    { value: "over10000", label: `${money(10000)} and up` },
  ];
}

export const QUOTE_TYPE_FILTERS = [
  { value: ALL, label: "All quote types" },
  { value: "itemized", label: "Itemized" },
  { value: "placeholder", label: "Placeholder" },
];

export const ODDS_FILTERS = [
  { value: ALL, label: "Any closing odds" },
  { value: "likely", label: "Likely (8-10)" },
  { value: "possible", label: "Possible (5-7)" },
  { value: "unlikely", label: "Unlikely (1-4)" },
];

/** The filters built from this store's own lists. */
export function profileFilters(choices: ClientProfileChoices) {
  return {
    timeline: optionsFrom(choices.timelines, "Any timeline"),
    residence: optionsFrom(choices.residences, "Any residence"),
    room: optionsFrom(choices.rooms, "Any room"),
  };
}

export const PIPELINE_SORTS = [
  { value: "newest", label: "Newest quote" },
  { value: "value", label: "Highest value" },
  { value: "waiting", label: "Longest since contact" },
  { value: "nextFollowUp", label: "Next follow-up" },
  { value: "odds", label: "Best closing odds" },
];

export interface PipelineFilters {
  followUp: string;
  store: string;
  tier: string;
  client: string;
  value: string;
  quoteType: string;
  timeline: string;
  odds: string;
  residence: string;
  room: string;
  sort: string;
}

export const DEFAULT_PIPELINE_FILTERS: PipelineFilters = {
  followUp: ALL,
  store: ALL,
  tier: ALL,
  client: ALL,
  value: ALL,
  quoteType: ALL,
  timeline: ALL,
  odds: ALL,
  residence: ALL,
  room: ALL,
  sort: "newest",
};

export interface FilterableQuote {
  storeLocation: string | null;
  totalAmount: number;
  followUpState: FollowUpState;
  lastInteractionAt: string | null;
  isPlaceholderQuote: boolean;
  daysSinceContact: number | null;
  daysSinceCreated: number;
  customer: {
    leadTier: LeadTier | null;
    history: { orderCount: number; lastPurchase: unknown | null } | null;
    profile: ClientProfileView | null;
  } | null;
  interactions: { notes: string | null }[];
}

function matchesFollowUp(quote: FilterableQuote, filter: string): boolean {
  if (filter === "attention") return needsAttention(quote.followUpState);
  if (filter === "scheduled") return quote.followUpState === "scheduled";
  if (filter === "noContact") return quote.lastInteractionAt === null;
  return true;
}

function matchesClient(quote: FilterableQuote, filter: string): boolean {
  if (filter === ALL) return true;
  const history = quote.customer?.history;
  if (!history) return false;
  return filter === "past" ? hasPurchased(history) : !hasPurchased(history);
}

function matchesValue(quote: FilterableQuote, filter: string): boolean {
  if (filter === "under2500") return quote.totalAmount < 2500;
  if (filter === "2500to10000") return quote.totalAmount >= 2500 && quote.totalAmount < 10000;
  if (filter === "over10000") return quote.totalAmount >= 10000;
  return true;
}

function matchesQuoteType(quote: FilterableQuote, filter: string): boolean {
  if (filter === "itemized") return !quote.isPlaceholderQuote;
  if (filter === "placeholder") return quote.isPlaceholderQuote;
  return true;
}

function matchesOdds(quote: FilterableQuote, filter: string): boolean {
  if (filter === ALL) return true;
  const odds = quote.customer?.profile?.closeLikelihood ?? null;
  if (odds === null) return false;
  if (filter === "likely") return odds >= 8;
  if (filter === "possible") return odds >= 5 && odds < 8;
  return odds < 5;
}

function matchesProfileChoice(actual: string | null | undefined, filter: string): boolean {
  return filter === ALL || actual === filter;
}

export function filterPipelineQuotes<T extends FilterableQuote>(
  quotes: T[],
  filters: PipelineFilters,
): T[] {
  return quotes.filter((quote) => {
    const profile = quote.customer?.profile;
    return (
      matchesFollowUp(quote, filters.followUp) &&
      (filters.store === ALL || quote.storeLocation === filters.store) &&
      (filters.tier === ALL || quote.customer?.leadTier === filters.tier) &&
      matchesClient(quote, filters.client) &&
      matchesValue(quote, filters.value) &&
      matchesQuoteType(quote, filters.quoteType) &&
      matchesProfileChoice(profile?.projectTimeline, filters.timeline) &&
      matchesOdds(quote, filters.odds) &&
      matchesProfileChoice(profile?.residenceType, filters.residence) &&
      (filters.room === ALL || Boolean(profile?.roomsOfInterest.includes(filters.room)))
    );
  });
}

function quoteOdds(quote: FilterableQuote): number {
  return quote.customer?.profile?.closeLikelihood ?? 0;
}

function waitingDays(quote: FilterableQuote): number {
  return quote.daysSinceContact ?? quote.daysSinceCreated;
}

function compareNextFollowUp(a: FilterableQuote, b: FilterableQuote): number {
  const aDate = a.customer?.profile?.nextFollowUpDate ?? null;
  const bDate = b.customer?.profile?.nextFollowUpDate ?? null;
  if (aDate === bDate) return 0;
  if (aDate === null) return 1;
  if (bDate === null) return -1;
  return aDate.localeCompare(bDate);
}

/** Newest is the order the API already returns. */
export function sortPipelineQuotes<T extends FilterableQuote>(quotes: T[], sort: string): T[] {
  const sorted = [...quotes];
  if (sort === "value") sorted.sort((a, b) => b.totalAmount - a.totalAmount);
  if (sort === "waiting") sorted.sort((a, b) => waitingDays(b) - waitingDays(a));
  if (sort === "nextFollowUp") sorted.sort(compareNextFollowUp);
  if (sort === "odds") sorted.sort((a, b) => quoteOdds(b) - quoteOdds(a));
  return sorted;
}

export function countActiveFilters(filters: PipelineFilters): number {
  return Object.entries(filters).filter(([key, value]) => key !== "sort" && value !== ALL).length;
}

/** The stores on the loaded quotes, plus any store already selected so the
 *  dropdown never shows a blank when the view changes under a saved filter. */
export function storeFilterOptions(
  stores: (string | null)[],
  selected: string,
): { value: string; label: string }[] {
  const names = new Set(stores.filter((store): store is string => Boolean(store)));
  if (selected !== ALL) names.add(selected);
  return optionsFrom(
    [...names].sort((a, b) => a.localeCompare(b)),
    "All stores",
  );
}

/** The text that explains why a search found this client, so an older note isn't left
 *  hidden. Prefers text holding every searched word. */
export function findMatchingText(texts: readonly string[], search: string): string | null {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const holds = (text: string, word: string) => text.toLowerCase().includes(word);
  return (
    texts.find((text) => words.every((word) => holds(text, word))) ??
    texts.find((text) => words.some((word) => holds(text, word))) ??
    null
  );
}

export function findMatchingNote(quote: FilterableQuote, search: string): string | null {
  const notes = quote.interactions
    .map((entry) => entry.notes)
    .filter((text): text is string => Boolean(text));
  return findMatchingText([...notes, ...clientInfoTexts(quote.customer?.profile)], search);
}
