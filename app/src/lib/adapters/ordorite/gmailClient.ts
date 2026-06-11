// /app/src/lib/adapters/ordorite/gmailClient.ts
//
// Server-only Gmail API client using a service account with domain-wide
// delegation, used by the legacy-POS report-import orchestrator. Credentials
// resolve DB-first (Settings -> Integrations, provider "gmail") with env
// fallback: serviceAccountJson may be the raw JSON (DB) or a file path
// (GMAIL_SERVICE_ACCOUNT_PATH, the Docker-volume mount style); delegateEmail
// falls back to GMAIL_DELEGATE_EMAIL / GMAIL_IMPERSONATE_EMAIL.

import { google } from "googleapis";
import { readFileSync } from "fs";
import { resolveCredential } from "@/lib/integrationCredentials";

interface GmailAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
}

export interface GmailMessage {
  id: string;
  subject: string;
  date: string;
  attachments: GmailAttachmentMeta[];
}

// The DB stores the full JSON; the env fallback historically stored a path to
// a mounted file. Accept both: a value starting with "{" is the JSON itself.
async function getKeyFile(): Promise<Record<string, unknown>> {
  const raw = await resolveCredential("gmail", "serviceAccountJson", "GMAIL_SERVICE_ACCOUNT_PATH");
  if (!raw) {
    throw new Error(
      "Gmail service account is not configured. Paste the service-account JSON in Settings -> Integrations -> Gmail, or set GMAIL_SERVICE_ACCOUNT_PATH.",
    );
  }
  const text = raw.trim().startsWith("{") ? raw : readFileSync(raw, "utf-8");
  return JSON.parse(text);
}

async function buildGmailService(impersonateEmail?: string) {
  const keyFile = await getKeyFile();
  const email =
    impersonateEmail ||
    (await resolveCredential("gmail", "delegateEmail", "GMAIL_DELEGATE_EMAIL")) ||
    process.env.GMAIL_IMPERSONATE_EMAIL;
  if (!email) {
    throw new Error(
      "Gmail delegate email is not configured. Set it in Settings -> Integrations -> Gmail, or via GMAIL_DELEGATE_EMAIL.",
    );
  }

  const auth = new google.auth.JWT({
    email: keyFile.client_email as string,
    key: keyFile.private_key as string,
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ],
    subject: email,
  });

  return google.gmail({ version: "v1", auth });
}

// Resolve a label name to its ID, creating it if it does not exist.
async function resolveLabelId(
  gmail: ReturnType<typeof google.gmail>,
  labelName: string,
): Promise<string> {
  const labelsRes = await gmail.users.labels.list({ userId: "me" });
  const labels = labelsRes.data.labels || [];
  const existing = labels.find((l) => l.name?.toLowerCase() === labelName.toLowerCase());
  if (existing?.id) return existing.id;

  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name: labelName,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    },
  });
  return created.data.id!;
}

// List emails with the Automations label that have attachments.
export async function listAutomationEmails(): Promise<GmailMessage[]> {
  const gmail = await buildGmailService();
  const labelName = process.env.GMAIL_AUTOMATION_LABEL || "Automations";
  const labelId = await resolveLabelId(gmail, labelName);

  const res = await gmail.users.messages.list({
    userId: "me",
    labelIds: [labelId],
    q: "has:attachment",
    maxResults: 50,
  });

  if (!res.data.messages || res.data.messages.length === 0) {
    return [];
  }

  const messages: GmailMessage[] = [];
  for (const msgRef of res.data.messages) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: msgRef.id!,
    });

    const headers = msg.data.payload?.headers || [];
    const subject = headers.find((h) => h.name === "Subject")?.value || "(no subject)";
    const date = headers.find((h) => h.name === "Date")?.value || new Date().toISOString();

    const attachments: GmailAttachmentMeta[] = [];
    const parts = msg.data.payload?.parts || [];
    for (const part of parts) {
      if (
        part.filename &&
        part.filename.toLowerCase().endsWith(".csv") &&
        part.body?.attachmentId
      ) {
        attachments.push({
          attachmentId: part.body.attachmentId,
          filename: part.filename,
          mimeType: part.mimeType || "text/csv",
        });
      }
    }

    if (attachments.length > 0) {
      messages.push({
        id: msgRef.id!,
        subject,
        date,
        attachments,
      });
    }
  }

  return messages;
}

// Download a specific attachment as a UTF-8 string.
export async function getAttachment(messageId: string, attachmentId: string): Promise<string> {
  const gmail = await buildGmailService();
  const res = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: attachmentId,
  });

  const data = res.data.data;
  if (!data) throw new Error("Attachment data is empty");

  // Gmail returns base64url-encoded data
  return Buffer.from(data, "base64url").toString("utf-8");
}

// Move an email from the Automations label to a Processed label.
export async function markProcessed(messageId: string): Promise<void> {
  const gmail = await buildGmailService();
  const automationLabel = process.env.GMAIL_AUTOMATION_LABEL || "Automations";
  const processedLabel = process.env.GMAIL_PROCESSED_LABEL || "Automations/Processed";

  const automationLabelId = await resolveLabelId(gmail, automationLabel);
  const processedLabelId = await resolveLabelId(gmail, processedLabel);

  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      removeLabelIds: [automationLabelId],
      addLabelIds: [processedLabelId],
    },
  });
}
