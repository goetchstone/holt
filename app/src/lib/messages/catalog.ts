// /app/src/lib/messages/catalog.ts
//
// GAP-13: the messages Holt sends a customer by itself, as the code knows them.
// The kind decides which event sends it and what it may say. The store's row
// (CustomerMessageSetting, Settings › Customer messages) decides whether it
// goes at all, its wording, whether it carries the order link, and when it
// goes (rule 62: config selects behaviour, it never supplies it). Every kind
// starts off, and a store switches on the ones it wants (owner, 2026-11-03:
// "All configurations").
//
// Pure: the Settings screen and the server share it (rule 7).

export const MESSAGE_KINDS = [
  "ARRIVED",
  "DELIVERY_SCHEDULED",
  "DELIVERY_REMINDER",
  "REVIEW_INVITE",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export function isMessageKind(value: unknown): value is MessageKind {
  return typeof value === "string" && (MESSAGE_KINDS as readonly string[]).includes(value);
}

/** What each {placeholder} becomes (lib/messages/render.ts fills them). */
export const PLACEHOLDERS = {
  customer: 'The customer\'s first name (their full name without one, or "there" with neither)',
  order: "The order number",
  store: "Your store's name",
  pieces: "The pieces the message is about",
  when: "The delivery day, with its time window when dispatch set one",
} as const;
export type Placeholder = keyof typeof PLACEHOLDERS;

/**
 * When a kind goes:
 *   at-once         as soon as Holt sees the event (within one run of the
 *                   email-queue cron);
 *   before-delivery offsetDays before the delivery day, at sendHour of the
 *                   store's day;
 *   after-handover  offsetDays after the day the goods were handed over, at
 *                   sendHour.
 */
export type MessageTiming = "at-once" | "before-delivery" | "after-handover";

/**
 * How a message goes (GAP-12). CUSTOMER follows each customer's own
 * preferredChannel, and email for one with none. EMAIL to start: a store sets
 * up a text provider before anything can go by text.
 */
export const MESSAGE_CHANNELS = ["EMAIL", "TEXT", "BOTH", "CUSTOMER"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const CHANNEL_LABELS: Record<MessageChannel, string> = {
  EMAIL: "Email",
  TEXT: "Text",
  BOTH: "Email and text",
  CUSTOMER: "Whichever the customer prefers",
};

export function isMessageChannel(value: unknown): value is MessageChannel {
  return typeof value === "string" && (MESSAGE_CHANNELS as readonly string[]).includes(value);
}

/** Which channels a message takes for this customer. */
export function channelsFor(
  channel: MessageChannel,
  preferred: string | null | undefined,
): { email: boolean; text: boolean } {
  const choice = channel === "CUSTOMER" ? (preferred ?? "EMAIL") : channel;
  return {
    email: choice === "EMAIL" || choice === "BOTH",
    text: choice === "TEXT" || choice === "BOTH",
  };
}

export interface MessageDefaults {
  subject: string;
  body: string;
  includeOrderLink: boolean;
  offsetDays: number | null;
  sendHour: number | null;
  textBody: string;
  textIncludeOrderLink: boolean;
}

export interface KindDefinition {
  kind: MessageKind;
  label: string;
  /** What sends it, as the Settings screen says it. */
  sentWhen: string;
  placeholders: readonly Placeholder[];
  timing: MessageTiming;
  /** Goes to a page of the store's own (its review page): linkUrl is required to switch it on. */
  needsLink: boolean;
  defaults: MessageDefaults;
}

export const MESSAGE_CATALOG: Record<MessageKind, KindDefinition> = {
  ARRIVED: {
    kind: "ARRIVED",
    label: "Your furniture has arrived",
    sentWhen:
      "Goods ordered for a customer are received from the vendor. One message per order lists what came in; each receipt is announced once.",
    placeholders: ["customer", "order", "store", "pieces"],
    timing: "at-once",
    needsLink: false,
    defaults: {
      subject: "Your order {order} has arrived",
      body: "Hi {customer},\n\nGood news: {pieces} from your order {order} arrived at {store}, and we'll be in touch to arrange delivery or pickup.",
      includeOrderLink: true,
      offsetDays: null,
      sendHour: null,
      textBody:
        "{store}: {pieces} from your order {order} arrived. We'll be in touch to arrange delivery or pickup.",
      textIncludeOrderLink: true,
    },
  },
  DELIVERY_SCHEDULED: {
    kind: "DELIVERY_SCHEDULED",
    label: "Your delivery is scheduled",
    sentWhen:
      "A delivery is put on a delivery run, and again whenever its day changes. Deliveries already scheduled when you switch this on are not announced.",
    placeholders: ["customer", "order", "store", "pieces", "when"],
    timing: "at-once",
    needsLink: false,
    defaults: {
      subject: "Your delivery from {store} is scheduled",
      body: "Hi {customer},\n\nYour delivery of order {order} is scheduled for {when}.\n\nWe'll bring: {pieces}.\n\nIf that day doesn't work for you, please call us.",
      includeOrderLink: true,
      offsetDays: null,
      sendHour: null,
      textBody:
        "{store}: your delivery of order {order} is scheduled for {when}. If that doesn't work for you, please call us.",
      textIncludeOrderLink: true,
    },
  },
  DELIVERY_REMINDER: {
    kind: "DELIVERY_REMINDER",
    label: "Delivery reminder",
    sentWhen:
      "Some days before a scheduled delivery, at an hour of your day. A reminder that can't go on its day (the delivery was booked later) is not sent late.",
    placeholders: ["customer", "order", "store", "pieces", "when"],
    timing: "before-delivery",
    needsLink: false,
    defaults: {
      subject: "Reminder: your delivery from {store}",
      body: "Hi {customer},\n\nA reminder that we're delivering order {order} on {when}: {pieces}.\n\nPlease make sure someone is home and there's a clear path for the pieces.",
      includeOrderLink: true,
      offsetDays: 1,
      sendHour: 9,
      textBody: "{store}: a reminder that we're delivering order {order} on {when}.",
      textIncludeOrderLink: true,
    },
  },
  REVIEW_INVITE: {
    kind: "REVIEW_INVITE",
    label: "Review invitation",
    sentWhen:
      "Some days after an order is handed over, at an hour of your day. Not sent once goods on the order are being returned, or if the handover was undone.",
    placeholders: ["customer", "order", "store", "pieces"],
    timing: "after-handover",
    needsLink: true,
    defaults: {
      subject: "How did we do?",
      body: "Hi {customer},\n\nThank you for your order {order} from {store}, and we hope you're enjoying your new furniture.\n\nIf you have a moment, we'd love to hear how we did.",
      includeOrderLink: true,
      offsetDays: 3,
      sendHour: 10,
      textBody: "{store}: thank you for your order {order}. We'd love to hear how we did.",
      textIncludeOrderLink: false,
    },
  },
};

export const SUBJECT_MAX = 150;
export const BODY_MAX = 4000;
export const LINK_MAX = 500;
/** About four text segments: each one is billed, and a longer text gets split or refused. */
export const TEXT_MAX = 640;
/** The range the database CHECKs too (migration 20261103220000). */
export const OFFSET_DAYS_MAX = 90;

/** A message as a store sets it up; what Settings sends and the server stores. */
export interface MessageSettingInput {
  isActive: boolean;
  subject: string;
  body: string;
  includeOrderLink: boolean;
  offsetDays: number | null;
  sendHour: number | null;
  linkUrl: string | null;
  channel: MessageChannel;
  textBody: string;
  textIncludeOrderLink: boolean;
}

/**
 * The text staff send from the order page with the customer's link (GAP-12). It
 * isn't one of the automatic kinds: nothing sends it by itself, so it has no
 * setting, and its history row names this kind.
 */
export const ORDER_LINK_KIND = "ORDER_LINK";
export const ORDER_LINK_LABEL = "Order link, sent by staff";
export const ORDER_LINK_TEXT = "{store}: here's your order {order}.";

const PLACEHOLDER_RE = /\{([a-zA-Z]+)\}/g;

/** The {placeholders} a text uses that its kind can't fill. */
export function unknownPlaceholders(kind: MessageKind, text: string): string[] {
  const allowed = new Set<string>(MESSAGE_CATALOG[kind].placeholders);
  const unknown = new Set<string>();
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!allowed.has(m[1])) unknown.add(`{${m[1]}}`);
  }
  return [...unknown];
}

function isWebLink(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function timingProblem(def: KindDefinition, input: MessageSettingInput): string | null {
  if (def.timing === "at-once") return null;
  const { offsetDays, sendHour } = input;
  if (
    offsetDays == null ||
    !Number.isInteger(offsetDays) ||
    offsetDays < 0 ||
    offsetDays > OFFSET_DAYS_MAX
  ) {
    return `Say how many days ${def.timing === "before-delivery" ? "before the delivery" : "after the handover"} it goes: a whole number from 0 to ${OFFSET_DAYS_MAX}.`;
  }
  if (sendHour == null || !Number.isInteger(sendHour) || sendHour < 0 || sendHour > 23) {
    return "Say the hour of the day it goes, 0 to 23.";
  }
  return null;
}

/** What's wrong with its subject and wording, in both channels. */
function wordingProblem(kind: MessageKind, input: MessageSettingInput): string | null {
  const subject = input.subject.trim();
  const body = input.body.trim();
  const textBody = input.textBody.trim();
  if (!subject) return "Give the message a subject.";
  if (subject.length > SUBJECT_MAX) return `Keep the subject under ${SUBJECT_MAX} characters.`;
  if (!body) return "Give the message some wording.";
  if (body.length > BODY_MAX) return `Keep the wording under ${BODY_MAX} characters.`;
  if (input.channel !== "EMAIL" && !textBody) return "Give the text some wording.";
  if (textBody.length > TEXT_MAX) return `Keep the text under ${TEXT_MAX} characters.`;
  const unknown = unknownPlaceholders(kind, `${subject}\n${body}\n${textBody}`);
  if (unknown.length === 0) return null;
  const fillable = MESSAGE_CATALOG[kind].placeholders.map((p) => `{${p}}`).join(", ");
  return `This message can't fill ${unknown.join(", ")}. It can use ${fillable}.`;
}

function linkProblem(def: KindDefinition, input: MessageSettingInput): string | null {
  const link = input.linkUrl?.trim() ?? "";
  if (link) {
    if (link.length > LINK_MAX) return `Keep the link under ${LINK_MAX} characters.`;
    if (!isWebLink(link)) return "The link must be a web address starting https://";
  }
  if (def.needsLink && input.isActive && !link) {
    return "Add the link to your review page before switching this on.";
  }
  return null;
}

/** Why a message can't be saved as given, or null. Checked on the screen and again by the route. */
export function messageSettingProblem(
  kind: MessageKind,
  input: MessageSettingInput,
): string | null {
  if (!isMessageChannel(input.channel)) return "Choose how the message goes.";
  const def = MESSAGE_CATALOG[kind];
  return wordingProblem(kind, input) ?? timingProblem(def, input) ?? linkProblem(def, input);
}
