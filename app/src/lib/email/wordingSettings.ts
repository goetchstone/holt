// /app/src/lib/email/wordingSettings.ts
//
// GAP-37: reading and saving what a store has set for its emails. getEmailChrome is what
// every sender calls, so a store's look and wording reach them all. Each override is a
// row (EmailWording). A blank or missing field is the suggested wording, so a store can
// change one line and leave the rest to follow the catalog.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAppSettings } from "@/lib/appSettings";
import { readEmailLook, type EmailLook } from "./look";
import type { EmailChrome } from "./templates";
import {
  EMAIL_WORDING_FIELDS,
  emailWordingProblem,
  isEmailKind,
  type EmailKind,
  type EmailWordingOverride,
} from "./wordingCatalog";

type Db = Pick<Prisma.TransactionClient, "emailWording">;

export class EmailWordingError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
    this.name = "EmailWordingError";
  }
}

function baseUrl(): string {
  return (process.env.NEXTAUTH_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export async function getEmailLook(): Promise<EmailLook> {
  return readEmailLook(await getAppSettings(), baseUrl());
}

/** The store's look and its wording for this email, for a template. */
export async function getEmailChrome(kind: EmailKind, db: Db = prisma): Promise<EmailChrome> {
  const [look, wording] = await Promise.all([
    getEmailLook(),
    db.emailWording.findUnique({ where: { key: kind } }),
  ]);
  return {
    look,
    wording: wording
      ? {
          subject: wording.subject,
          heading: wording.heading,
          intro: wording.intro,
          closing: wording.closing,
        }
      : {},
  };
}

/** Everything a store has changed, by email. */
export async function getEmailWordings(db: Db = prisma) {
  const rows = await db.emailWording.findMany();
  const byKind: Partial<Record<EmailKind, EmailWordingOverride>> = {};
  for (const row of rows) {
    if (!isEmailKind(row.key)) continue;
    byKind[row.key] = {
      subject: row.subject,
      heading: row.heading,
      intro: row.intro,
      closing: row.closing,
    };
  }
  return byKind;
}

/** Text as typed, or null for "use the suggested wording". Refuses anything but text. */
export function readWordingBody(body: unknown): EmailWordingOverride {
  const input = (body ?? {}) as Record<string, unknown>;
  const override: EmailWordingOverride = {};
  for (const field of EMAIL_WORDING_FIELDS) {
    const value = input[field];
    if (value === undefined || value === null) {
      override[field] = null;
    } else if (typeof value !== "string") {
      throw new EmailWordingError(`The ${field} must be text.`);
    } else {
      override[field] = value.trim() ? value : null;
    }
  }
  return override;
}

export async function saveEmailWording(
  db: Db,
  keyInput: unknown,
  body: unknown,
  actor: string | null,
): Promise<EmailWordingOverride> {
  if (!isEmailKind(keyInput)) throw new EmailWordingError("No such email.", 404);
  const override = readWordingBody(body);
  const problem = emailWordingProblem(keyInput, override);
  if (problem) throw new EmailWordingError(problem);
  const data = {
    subject: override.subject ?? null,
    heading: override.heading ?? null,
    intro: override.intro ?? null,
    closing: override.closing ?? null,
    updatedBy: actor,
  };
  await db.emailWording.upsert({
    where: { key: keyInput },
    create: { key: keyInput, ...data },
    update: data,
  });
  return override;
}

/** Back to the suggested wording. */
export async function resetEmailWording(db: Db, keyInput: unknown): Promise<void> {
  if (!isEmailKind(keyInput)) throw new EmailWordingError("No such email.", 404);
  await db.emailWording.deleteMany({ where: { key: keyInput } });
}
