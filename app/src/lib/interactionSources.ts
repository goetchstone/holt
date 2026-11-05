// /app/src/lib/interactionSources.ts
//
// Single source of truth for the CustomerInteraction.source values the sales side
// writes, shared by the pipeline UI, the create endpoint and every read that asks
// "when did we last reach this client?". A contact source means we reached them,
// so it moves days-since-contact. A note source is only something we know about
// them, so it must not.

export const CONTACT_SOURCES = ["PHONE", "EMAIL", "WALK_IN", "APPOINTMENT"] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

// NOTE belongs to the client and shows on all their quotes. MANAGER_NOTE stays on
// the quote it was written against.
export const CLIENT_NOTE_SOURCE = "NOTE";
export const NOTE_SOURCES = [CLIENT_NOTE_SOURCE, "MANAGER_NOTE"] as const;
export type NoteSource = (typeof NOTE_SOURCES)[number];

export const INTERACTION_SOURCES = [...CONTACT_SOURCES, ...NOTE_SOURCES] as const;
export type InteractionSource = (typeof INTERACTION_SOURCES)[number];

export const INTERACTION_SOURCE_LABELS: Record<InteractionSource, string> = {
  PHONE: "Phone",
  EMAIL: "Email",
  WALK_IN: "Walk-in",
  APPOINTMENT: "Appointment",
  NOTE: "Note",
  MANAGER_NOTE: "Manager note",
};

export function isInteractionSource(value: unknown): value is InteractionSource {
  return (INTERACTION_SOURCES as readonly unknown[]).includes(value);
}

export function isNoteSource(source: string): boolean {
  return (NOTE_SOURCES as readonly string[]).includes(source);
}
