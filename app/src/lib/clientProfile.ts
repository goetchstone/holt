// /app/src/lib/clientProfile.ts
//
// What a salesperson keeps on file about a client (GAP-36). Contact details, showroom,
// addresses and what they bought are left out because Holt already has them.
//
// The form's choices are the store's: what one store calls a budget band or a next step
// isn't another's, so they live in AppSettings.clientProfileChoices, with the suggestions
// here until a store changes them (rule 61). An answer saved before a choice was removed
// stays valid on that client. Pure, so it is safe in client bundles.

import { dayKeyToDbDate, dbDateToDayKey, isDayKey } from "@/lib/reports/businessDay";

export interface ClientProfileChoices {
  rooms: string[];
  residences: string[];
  timelines: string[];
  budgets: string[];
  decisionMakers: string[];
  nextSteps: string[];
  suggestedKeywords: string[];
}

export const CLIENT_PROFILE_CHOICE_LABELS: Record<keyof ClientProfileChoices, string> = {
  rooms: "Rooms of interest",
  residences: "Residence types",
  timelines: "Project timelines",
  budgets: "Budget ranges",
  decisionMakers: "Decision makers",
  nextSteps: "Next steps",
  suggestedKeywords: "Suggested keywords",
};

export const DEFAULT_CLIENT_PROFILE_CHOICES: ClientProfileChoices = {
  rooms: [
    "Living Room",
    "Dining Room",
    "Primary Bedroom",
    "Guest Bedroom",
    "Family Room",
    "Office",
    "Outdoor",
    "Whole Home",
    "Rugs",
    "Accessories",
  ],
  residences: ["Primary", "Secondary/Vacation"],
  timelines: ["Next 30 days", "1-3 months", "3-6 months", "6+ months"],
  budgets: ["Under 10K", "10K-25K", "25K+", "Open"],
  decisionMakers: ["Sole decision maker", "With spouse or partner", "With family member"],
  nextSteps: ["Schedule house call", "House call scheduled", "Quoting", "Order samples"],
  suggestedKeywords: ["Outdoor living", "Entertaining space", "Pets and kids"],
};

export const MAX_CHOICES_PER_LIST = 40;
export const MAX_CHOICE_LENGTH = 60;

const CHOICE_KEYS = Object.keys(DEFAULT_CLIENT_PROFILE_CHOICES) as (keyof ClientProfileChoices)[];

/** What's stored, with the suggestions for anything a store hasn't set. */
export function readClientProfileChoices(stored: unknown): ClientProfileChoices {
  const input = (stored ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    CHOICE_KEYS.map((key) => {
      const list = input[key];
      const usable = Array.isArray(list) && list.every((item) => typeof item === "string");
      return [key, usable ? (list as string[]) : DEFAULT_CLIENT_PROFILE_CHOICES[key]];
    }),
  ) as unknown as ClientProfileChoices;
}

/** A store's lists from Settings, cleaned up, or why they can't be saved. */
export function parseClientProfileChoices(
  value: unknown,
): { ok: true; choices: ClientProfileChoices } | { ok: false; error: string } {
  const input = (value ?? {}) as Record<string, unknown>;
  const choices = { ...DEFAULT_CLIENT_PROFILE_CHOICES };
  for (const key of CHOICE_KEYS) {
    const list = input[key];
    if (list === undefined) continue;
    const label = CLIENT_PROFILE_CHOICE_LABELS[key];
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string")) {
      return { ok: false, error: `${label} must be a list of text.` };
    }
    const byLowerCase = new Map<string, string>();
    for (const raw of list as string[]) {
      const item = raw.trim();
      if (item && !byLowerCase.has(item.toLowerCase())) byLowerCase.set(item.toLowerCase(), item);
    }
    const cleaned = [...byLowerCase.values()];
    if (cleaned.length > MAX_CHOICES_PER_LIST) {
      return { ok: false, error: `${label} can hold at most ${MAX_CHOICES_PER_LIST} entries.` };
    }
    if (cleaned.some((item) => item.length > MAX_CHOICE_LENGTH)) {
      return {
        ok: false,
        error: `${label} entries can be at most ${MAX_CHOICE_LENGTH} characters.`,
      };
    }
    choices[key] = cleaned;
  }
  return { ok: true, choices };
}

const MAX_KEYWORDS = 20;
const MAX_KEYWORD_LENGTH = 60;

export const CLOSE_LIKELIHOOD_MIN = 1;
export const CLOSE_LIKELIHOOD_MAX = 10;

/** A client profile as the API sends it. Dates are YYYY-MM-DD. */
export interface ClientProfileView {
  projectDescription: string | null;
  stylePreferences: string | null;
  homes: string | null;
  preferredBrands: string | null;
  keywords: string[];
  roomsOfInterest: string[];
  residenceType: string | null;
  projectTimeline: string | null;
  budgetRange: string | null;
  decisionMaker: string | null;
  closeLikelihood: number | null;
  expectedCloseDate: string | null;
  nextSteps: string[];
  nextFollowUpDate: string | null;
}

export const EMPTY_CLIENT_PROFILE: ClientProfileView = {
  projectDescription: null,
  stylePreferences: null,
  homes: null,
  preferredBrands: null,
  keywords: [],
  roomsOfInterest: [],
  residenceType: null,
  projectTimeline: null,
  budgetRange: null,
  decisionMaker: null,
  closeLikelihood: null,
  expectedCloseDate: null,
  nextSteps: [],
  nextFollowUpDate: null,
};

/** The profile's columns, ready for a Prisma write. */
export type ClientProfileData = Omit<
  ClientProfileView,
  "expectedCloseDate" | "nextFollowUpDate"
> & {
  expectedCloseDate: Date | null;
  nextFollowUpDate: Date | null;
  searchText: string | null;
};

interface ClientProfileRow extends ClientProfileData {
  // Prisma returns the row with more columns than the view needs.
  id?: number;
}

export function toClientProfileView(row: ClientProfileRow): ClientProfileView {
  return {
    projectDescription: row.projectDescription,
    stylePreferences: row.stylePreferences,
    homes: row.homes,
    preferredBrands: row.preferredBrands,
    keywords: row.keywords,
    roomsOfInterest: row.roomsOfInterest,
    residenceType: row.residenceType,
    projectTimeline: row.projectTimeline,
    budgetRange: row.budgetRange,
    decisionMaker: row.decisionMaker,
    closeLikelihood: row.closeLikelihood,
    expectedCloseDate: dbDateToDayKey(row.expectedCloseDate),
    nextSteps: row.nextSteps,
    nextFollowUpDate: dbDateToDayKey(row.nextFollowUpDate),
  };
}

/** True when a designer has recorded anything beyond the next follow-up date. */
export function hasClientInfo(profile: ClientProfileView | null): boolean {
  if (!profile) return false;
  return Boolean(
    profile.projectDescription ||
    profile.stylePreferences ||
    profile.homes ||
    profile.preferredBrands ||
    profile.keywords.length > 0 ||
    profile.roomsOfInterest.length > 0 ||
    profile.residenceType ||
    profile.projectTimeline ||
    profile.budgetRange ||
    profile.decisionMaker ||
    profile.closeLikelihood !== null ||
    profile.expectedCloseDate ||
    profile.nextSteps.length > 0,
  );
}

/** Everything on the profile a designer might type into search, in one column. */
export function buildProfileSearchText(
  profile: Omit<ClientProfileData, "expectedCloseDate" | "nextFollowUpDate" | "searchText">,
): string | null {
  const text = [
    profile.projectDescription,
    profile.stylePreferences,
    profile.homes,
    profile.preferredBrands,
    profile.keywords.join(", "),
    profile.roomsOfInterest.join(", "),
    profile.residenceType,
    profile.projectTimeline,
    profile.budgetRange,
    profile.decisionMaker,
    profile.nextSteps.join(", "),
  ]
    .filter(Boolean)
    .join("\n");
  return text || null;
}

/** The profile's text worth showing when a search matches it. */
export function clientInfoTexts(profile: ClientProfileView | null | undefined): string[] {
  if (!profile) return [];
  return [
    profile.projectDescription,
    profile.stylePreferences,
    profile.homes,
    profile.preferredBrands,
    profile.keywords.join(", "),
    profile.roomsOfInterest.join(", "),
    profile.residenceType,
  ].filter((text): text is string => Boolean(text));
}

/** When duplicates merge, the kept profile's answers stand and the other only fills
 *  its blanks. Without this, a row holding just a follow-up date would beat a
 *  duplicate's completed form. */
export function fillProfileGaps(
  kept: ClientProfileData,
  other: ClientProfileData,
): ClientProfileData {
  const merged = {
    projectDescription: kept.projectDescription ?? other.projectDescription,
    stylePreferences: kept.stylePreferences ?? other.stylePreferences,
    homes: kept.homes ?? other.homes,
    preferredBrands: kept.preferredBrands ?? other.preferredBrands,
    keywords: kept.keywords.length > 0 ? kept.keywords : other.keywords,
    roomsOfInterest: kept.roomsOfInterest.length > 0 ? kept.roomsOfInterest : other.roomsOfInterest,
    residenceType: kept.residenceType ?? other.residenceType,
    projectTimeline: kept.projectTimeline ?? other.projectTimeline,
    budgetRange: kept.budgetRange ?? other.budgetRange,
    decisionMaker: kept.decisionMaker ?? other.decisionMaker,
    closeLikelihood: kept.closeLikelihood ?? other.closeLikelihood,
    expectedCloseDate: kept.expectedCloseDate ?? other.expectedCloseDate,
    nextSteps: kept.nextSteps.length > 0 ? kept.nextSteps : other.nextSteps,
    nextFollowUpDate: kept.nextFollowUpDate ?? other.nextFollowUpDate,
  };
  return { ...merged, searchText: buildProfileSearchText(merged) };
}

class InvalidProfileField extends Error {}

function readChoice(value: unknown, choices: readonly string[], field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && choices.includes(value)) return value;
  throw new InvalidProfileField(`${field} must be one of: ${choices.join(", ")}`);
}

function readChoices(value: unknown, choices: readonly string[], field: string): string[] {
  if (value === null || value === undefined) return [];
  const isValidList =
    Array.isArray(value) && value.every((v) => typeof v === "string" && choices.includes(v));
  if (!isValidList) {
    throw new InvalidProfileField(`${field} must only contain: ${choices.join(", ")}`);
  }
  return [...new Set(value as string[])];
}

function readDate(value: unknown, field: string): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (isDayKey(value)) return dayKeyToDbDate(value);
  throw new InvalidProfileField(`${field} must be a date (YYYY-MM-DD)`);
}

function readLikelihood(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const isInRange =
    Number.isInteger(value) &&
    (value as number) >= CLOSE_LIKELIHOOD_MIN &&
    (value as number) <= CLOSE_LIKELIHOOD_MAX;
  if (isInRange) return value as number;
  throw new InvalidProfileField(
    `closeLikelihood must be a whole number from ${CLOSE_LIKELIHOOD_MIN} to ${CLOSE_LIKELIHOOD_MAX}`,
  );
}

function readKeywords(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((keyword) => typeof keyword !== "string")) {
    throw new InvalidProfileField("keywords must be a list of text");
  }
  const byLowerCase = new Map<string, string>();
  for (const raw of value as string[]) {
    const keyword = raw.trim();
    if (keyword && !byLowerCase.has(keyword.toLowerCase())) {
      byLowerCase.set(keyword.toLowerCase(), keyword);
    }
  }
  const keywords = [...byLowerCase.values()];
  if (keywords.length > MAX_KEYWORDS) {
    throw new InvalidProfileField(`keywords can hold at most ${MAX_KEYWORDS} entries`);
  }
  if (keywords.some((keyword) => keyword.length > MAX_KEYWORD_LENGTH)) {
    throw new InvalidProfileField(`keywords can be at most ${MAX_KEYWORD_LENGTH} characters`);
  }
  return keywords;
}

function readText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new InvalidProfileField(`${field} must be text`);
  return value.trim() || null;
}

export type ParsedClientProfile =
  { ok: true; data: ClientProfileData } | { ok: false; error: string };

/** This store's list, plus an answer saved before that choice was removed from it. */
export function withSavedAnswer(
  choices: readonly string[],
  saved: string | string[] | null | undefined,
): string[] {
  const held = [saved ?? []].flat();
  return [...new Set([...choices, ...held])];
}

/** Validate a full-replace PUT body. A missing field is saved as empty. `current` keeps an
 *  answer valid after a store removes that choice from its list. */
export function parseClientProfileBody(
  body: unknown,
  choices: ClientProfileChoices = DEFAULT_CLIENT_PROFILE_CHOICES,
  current?: {
    roomsOfInterest: string[];
    residenceType: string | null;
    projectTimeline: string | null;
    budgetRange: string | null;
    decisionMaker: string | null;
    nextSteps: string[];
  } | null,
): ParsedClientProfile {
  const input = (body ?? {}) as Record<string, unknown>;
  try {
    const fields = {
      projectDescription: readText(input.projectDescription, "projectDescription"),
      stylePreferences: readText(input.stylePreferences, "stylePreferences"),
      homes: readText(input.homes, "homes"),
      preferredBrands: readText(input.preferredBrands, "preferredBrands"),
      keywords: readKeywords(input.keywords),
      roomsOfInterest: readChoices(
        input.roomsOfInterest,
        withSavedAnswer(choices.rooms, current?.roomsOfInterest),
        "roomsOfInterest",
      ),
      residenceType: readChoice(
        input.residenceType,
        withSavedAnswer(choices.residences, current?.residenceType),
        "residenceType",
      ),
      projectTimeline: readChoice(
        input.projectTimeline,
        withSavedAnswer(choices.timelines, current?.projectTimeline),
        "projectTimeline",
      ),
      budgetRange: readChoice(
        input.budgetRange,
        withSavedAnswer(choices.budgets, current?.budgetRange),
        "budgetRange",
      ),
      decisionMaker: readChoice(
        input.decisionMaker,
        withSavedAnswer(choices.decisionMakers, current?.decisionMaker),
        "decisionMaker",
      ),
      closeLikelihood: readLikelihood(input.closeLikelihood),
      expectedCloseDate: readDate(input.expectedCloseDate, "expectedCloseDate"),
      nextSteps: readChoices(
        input.nextSteps,
        withSavedAnswer(choices.nextSteps, current?.nextSteps),
        "nextSteps",
      ),
      nextFollowUpDate: readDate(input.nextFollowUpDate, "nextFollowUpDate"),
    };
    return { ok: true, data: { ...fields, searchText: buildProfileSearchText(fields) } };
  } catch (err) {
    if (err instanceof InvalidProfileField) return { ok: false, error: err.message };
    throw err;
  }
}
