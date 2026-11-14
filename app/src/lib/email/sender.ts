// /app/src/lib/email/sender.ts
//
// Server-only nodemailer sender. Builds (and caches) a transport from the
// resolved SMTP config and sends one message. Returns { skipped: true } when
// SMTP is unconfigured so callers never special-case "email off". nodemailer
// uses Node net/tls -- this file must only be imported by API routes + the queue
// processor, never a client bundle.

import { createHash } from "node:crypto";
import nodemailer, { type Transporter } from "nodemailer";
import { getSmtpConfig, type SmtpConfig } from "./config";
import { DEFAULT_ORG_ID } from "@/lib/appSettings";
import { logError } from "@/lib/logger";

let cached: { key: string; transport: Transporter } | null = null;

// The transport is rebuilt whenever anything it was built from changes. The
// password is part of that: leaving it out kept sending with the old password
// after Settings saved a new one, until a restart. It is hashed, so the
// plaintext is not kept a second time in a long-lived string.
function configKey(c: SmtpConfig): string {
  const pass = createHash("sha256")
    .update(c.pass ?? "")
    .digest("hex");
  return `${c.host}:${c.port}:${c.secure}:${c.user ?? ""}:${pass}`;
}

function getTransport(c: SmtpConfig): Transporter {
  const key = configKey(c);
  if (cached && cached.key === key) return cached.transport;
  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });
  cached = { key, transport };
  return transport;
}

export interface SendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

/** A file sent with the message, such as a purchase order's PDF. */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export async function sendEmail(
  msg: { to: string; subject: string; html: string; attachments?: readonly EmailAttachment[] },
  orgId: number = DEFAULT_ORG_ID,
): Promise<SendResult> {
  const cfg = await getSmtpConfig(orgId);
  if (!cfg) return { ok: false, skipped: true };
  try {
    const from = cfg.fromName ? `${cfg.fromName} <${cfg.fromAddress}>` : cfg.fromAddress;
    await getTransport(cfg).sendMail({
      from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      attachments: msg.attachments?.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: a.content,
      })),
    });
    return { ok: true };
  } catch (err: unknown) {
    logError("Email send failed", err, { to: msg.to });
    return { ok: false, error: err instanceof Error ? err.message : "send failed" };
  }
}
