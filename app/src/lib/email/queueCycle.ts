// /app/src/lib/email/queueCycle.ts
//
// One pass of the email queue: queue the customer messages, low stock list and morning
// emails that are due, then send what's waiting. A step that can't queue doesn't stop
// the others, and what's already waiting still goes. Moved out of
// pages/api/automations/email-queue.ts so Admin > Automations and the route run the same
// thing (GAP-37, rule 14).

import { processEmailQueue } from "@/lib/email/queue";
import { queueDueMessages, type DueSummary } from "@/lib/messages/due";
import { queueFollowUpEmails, type FollowUpEmailResult } from "@/lib/followUpEmail";
import { queueLowStockAlert, type LowStockAlertResult } from "@/lib/purchasing/lowStockAlert";
import { processSmsQueue } from "@/lib/sms/queue";
import { logError } from "@/lib/logger";

export async function runEmailQueueCycle() {
  let messages: DueSummary | null = null;
  try {
    messages = await queueDueMessages();
  } catch (err: unknown) {
    logError("Customer messages could not be queued", err);
  }
  let lowStock: LowStockAlertResult | null = null;
  try {
    lowStock = await queueLowStockAlert();
  } catch (err: unknown) {
    logError("Low stock alert could not be queued", err);
  }
  let followUps: FollowUpEmailResult | null = null;
  try {
    followUps = await queueFollowUpEmails();
  } catch (err: unknown) {
    logError("Morning follow-up emails could not be queued", err);
  }
  const summary = await processEmailQueue();
  const texts = await processSmsQueue();
  return { summary, texts, messages, lowStock, followUps };
}
