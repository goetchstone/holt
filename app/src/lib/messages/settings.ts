// /app/src/lib/messages/settings.ts
//
// GAP-13: the store's automatic customer messages as it set them up
// (Settings › Customer messages, /api/customer-messages). One row per kind in
// lib/messages/catalog.ts; a kind with no row yet is written with its default
// wording and timing, switched off. Switching one on stamps activeSince, and
// only events after it send (lib/messages/due.ts).

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isSmsConfigured } from "@/lib/sms";
import {
  MESSAGE_CATALOG,
  MESSAGE_KINDS,
  isMessageChannel,
  isMessageKind,
  messageSettingProblem,
  type MessageChannel,
  type MessageKind,
  type MessageSettingInput,
} from "./catalog";

type Db = Pick<Prisma.TransactionClient, "customerMessageSetting">;

export class MessageSettingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "MessageSettingError";
  }
}

export interface MessageSettingRow extends MessageSettingInput {
  kind: MessageKind;
  activeSince: Date | null;
  updated: Date | null;
  updatedBy: string | null;
}

/** Every kind's setting, in the catalog's order. */
export async function getMessageSettings(db: Db = prisma): Promise<MessageSettingRow[]> {
  let rows = await db.customerMessageSetting.findMany();
  const missing = MESSAGE_KINDS.filter((k) => !rows.some((r) => r.kind === k));
  if (missing.length > 0) {
    await db.customerMessageSetting.createMany({
      data: missing.map((kind) => ({ kind, isActive: false, ...MESSAGE_CATALOG[kind].defaults })),
      skipDuplicates: true,
    });
    rows = await db.customerMessageSetting.findMany();
  }
  return MESSAGE_KINDS.flatMap((kind) => {
    const row = rows.find((r) => r.kind === kind);
    return row ? [settingRow(kind, row)] : [];
  });
}

function settingRow(
  kind: MessageKind,
  row: Omit<MessageSettingRow, "kind" | "channel" | "textBody"> & {
    channel: string;
    textBody: string | null;
  },
): MessageSettingRow {
  return {
    ...row,
    kind,
    // A CHECK holds the column to the known channels; a row can't say another.
    channel: row.channel as MessageChannel,
    // A row saved before texts has no wording of its own.
    textBody: row.textBody ?? MESSAGE_CATALOG[kind].defaults.textBody,
  };
}

function readNumber(raw: unknown, label: string): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n)) throw new MessageSettingError(`${label} must be a whole number.`);
  return n;
}

/** A body as the route receives it, read into a setting; the catalog's check then judges it. */
export function readSettingInput(kind: MessageKind, raw: unknown): MessageSettingInput {
  const body = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown, label: string) => {
    if (typeof v !== "string") throw new MessageSettingError(`${label} must be text.`);
    return v.trim();
  };
  const flag = (v: unknown, label: string) => {
    if (typeof v !== "boolean") throw new MessageSettingError(`${label} must be true or false.`);
    return v;
  };
  if (!isMessageChannel(body.channel)) {
    throw new MessageSettingError("Choose how the message goes.");
  }
  const timed = MESSAGE_CATALOG[kind].timing !== "at-once";
  const link = body.linkUrl;
  return {
    isActive: flag(body.isActive, "On or off"),
    subject: text(body.subject, "The subject"),
    body: text(body.body, "The wording"),
    includeOrderLink: flag(body.includeOrderLink, "Include the order link"),
    // A message that goes at once has no timing to keep.
    offsetDays: timed ? readNumber(body.offsetDays, "Days") : null,
    sendHour: timed ? readNumber(body.sendHour, "The hour") : null,
    linkUrl:
      link === undefined || link === null || link === "" ? null : text(link, "The link") || null,
    channel: body.channel,
    textBody: text(body.textBody, "The text's wording"),
    textIncludeOrderLink: flag(body.textIncludeOrderLink, "Include the order link in the text"),
  };
}

/** Save one kind's setting as given. Switching it on starts it from now. */
export async function saveMessageSetting(
  db: Db,
  rawKind: unknown,
  raw: unknown,
  actor: string | null,
): Promise<MessageSettingRow> {
  if (!isMessageKind(rawKind)) throw new MessageSettingError("No such message.", 404);
  const kind = rawKind;
  const input = readSettingInput(kind, raw);
  const problem = messageSettingProblem(kind, input);
  if (problem) throw new MessageSettingError(problem);
  // A store sets up its provider first, rather than switching on a message whose
  // texts would sit in the queue with nobody told why.
  if (input.isActive && input.channel !== "EMAIL" && !(await isSmsConfigured())) {
    throw new MessageSettingError(
      "Set up texting in Settings › Integrations before this message goes by text.",
    );
  }

  const current = (await getMessageSettings(db)).find((s) => s.kind === kind);
  const switchedOn = input.isActive && !current?.isActive;
  const row = await db.customerMessageSetting.update({
    where: { kind },
    data: {
      ...input,
      activeSince: switchedOn ? new Date() : (current?.activeSince ?? null),
      updatedBy: actor,
    },
  });
  return settingRow(kind, row);
}
