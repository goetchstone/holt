// /app/src/lib/adapters/ordorite/orchestrator.ts
//
// The legacy-POS auto-import run: list unprocessed emails -> download CSV
// attachments -> route by filename -> parse -> run the matching import runner
// -> one AutoImportLog row per attachment -> mark the email Processed ONLY
// when every routed attachment succeeded (failed files are re-fetched next
// run; every runner is idempotent via natural-key upserts, so retries are
// safe). Called by the /api/automations/gmail-import endpoint.

import { prisma } from "@/lib/prisma";
import Papa from "papaparse";
import { randomUUID } from "node:crypto";
import { listAutomationEmails, getAttachment, markProcessed } from "./gmailClient";
import { resolveImportRoute } from "./reportRouter";
import { isSkippableEmptyReport } from "./emptyReport";

export interface ImportRunSummary {
  runId: string;
  dryRun: boolean;
  emailsProcessed: number;
  emailsSkipped: number;
  imports: { filename: string; importType: string; status: string; recordCount: number }[];
  errors: string[];
  message?: string;
}

export async function runGmailImport(opts: {
  dryRun: boolean;
  createdBy: string;
}): Promise<ImportRunSummary> {
  const { dryRun, createdBy } = opts;
  const runId = randomUUID();

  const summary: ImportRunSummary = {
    runId,
    dryRun,
    emailsProcessed: 0,
    emailsSkipped: 0,
    imports: [],
    errors: [],
  };

  const emails = await listAutomationEmails();
  if (emails.length === 0) {
    summary.message = "No unprocessed emails found";
    return summary;
  }

  for (const email of emails) {
    let allAttachmentsSucceeded = true;

    for (const attachment of email.attachments) {
      const route = resolveImportRoute(attachment.filename);

      // Known-redundant file: skip silently.
      if (route === "skip") {
        await prisma.autoImportLog.create({
          data: {
            runId,
            emailId: email.id,
            emailSubject: email.subject,
            filename: attachment.filename,
            importType: "skip",
            status: "skipped",
          },
        });
        summary.imports.push({
          filename: attachment.filename,
          importType: "skip",
          status: "skipped",
          recordCount: 0,
        });
        continue;
      }

      // Unknown file: log and flag for an operator to add a route.
      if (!route) {
        await prisma.autoImportLog.create({
          data: {
            runId,
            emailId: email.id,
            emailSubject: email.subject,
            filename: attachment.filename,
            importType: "unknown",
            status: "skipped",
            errorMessage: "No import route for this filename",
          },
        });
        summary.imports.push({
          filename: attachment.filename,
          importType: "unknown",
          status: "skipped",
          recordCount: 0,
        });
        continue;
      }

      try {
        const csvText = await getAttachment(email.id, attachment.attachmentId);
        const parsed = Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          dynamicTyping: false,
          // Strip UTF-8 BOM from header names (the item export ships with a
          // BOM; without this the first column key would be `﻿Active` and
          // header-alias lookups would miss it). Trim as defense in depth.
          transformHeader: (h) => h.replace(/^﻿/, "").trim(),
        });

        const records = parsed.data as Record<string, unknown>[];

        // A no-activity daily report parses to zero rows plus an
        // UndetectableDelimiter warning. Skip it instead of throwing — a fatal
        // error blocks the WHOLE email from being marked Processed, stranding
        // every attachment to be re-fetched forever. Any non-empty file with
        // real parse errors stays fatal.
        if (isSkippableEmptyReport(records.length, parsed.errors)) {
          await prisma.autoImportLog.create({
            data: {
              runId,
              emailId: email.id,
              emailSubject: email.subject,
              filename: attachment.filename,
              importType: route.importType,
              status: "skipped",
              recordCount: 0,
              errorMessage: "Empty report — no rows to import",
            },
          });
          summary.imports.push({
            filename: attachment.filename,
            importType: route.importType,
            status: "skipped",
            recordCount: 0,
          });
          continue;
        }

        if (parsed.errors.length > 0) {
          const parseErrors = parsed.errors.map((e) => e.message).join("; ");
          throw new Error(`CSV parse errors: ${parseErrors}`);
        }
        if (records.length === 0) {
          throw new Error("CSV file contains no data rows");
        }

        if (dryRun) {
          summary.imports.push({
            filename: attachment.filename,
            importType: route.importType,
            status: "dry-run",
            recordCount: records.length,
          });
          continue;
        }

        const result = await route.runner(records, createdBy);
        const resultObj = result as Record<string, unknown>;

        const recordCount =
          (Number(resultObj.salesOrdersCreated) || 0) +
            (Number(resultObj.salesOrdersUpdated) || 0) +
            (Number(resultObj.quotesCreated) || 0) +
            (Number(resultObj.quotesUpdated) || 0) +
            (Number(resultObj.ordersUpdated) || 0) +
            (Number(resultObj.purchaseOrdersCreated) || 0) +
            (Number(resultObj.purchaseOrdersUpdated) || 0) +
            (Number(resultObj.productsCreated) || 0) +
            (Number(resultObj.productsUpdated) || 0) || records.length;

        await prisma.autoImportLog.create({
          data: {
            runId,
            emailId: email.id,
            emailSubject: email.subject,
            filename: attachment.filename,
            importType: route.importType,
            status: "success",
            recordCount,
            resultSummary: resultObj as object,
          },
        });
        summary.imports.push({
          filename: attachment.filename,
          importType: route.importType,
          status: "success",
          recordCount,
        });
      } catch (importError: unknown) {
        allAttachmentsSucceeded = false;
        const msg = importError instanceof Error ? importError.message : String(importError);

        await prisma.autoImportLog.create({
          data: {
            runId,
            emailId: email.id,
            emailSubject: email.subject,
            filename: attachment.filename,
            importType: route.importType,
            status: "error",
            errorMessage: msg,
          },
        });
        summary.imports.push({
          filename: attachment.filename,
          importType: route.importType,
          status: "error",
          recordCount: 0,
        });
        summary.errors.push(`${attachment.filename}: ${msg}`);
      }
    }

    // All-or-nothing: only a fully-succeeded email leaves the inbox label.
    if (allAttachmentsSucceeded && !dryRun) {
      try {
        await markProcessed(email.id);
        summary.emailsProcessed++;
      } catch (labelError: unknown) {
        const msg = labelError instanceof Error ? labelError.message : String(labelError);
        summary.errors.push(`Failed to mark email processed: ${msg}`);
        summary.emailsSkipped++;
      }
    } else {
      summary.emailsSkipped++;
    }
  }

  return summary;
}
