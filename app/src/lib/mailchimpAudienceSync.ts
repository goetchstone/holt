// /app/src/lib/mailchimpAudienceSync.ts
//
// Pushes new ERP customers into the configured Mailchimp audience.
// FileMaker used to do this; since the migration FileMaker no longer
// receives new customer data, so this runner takes over.
//
// Design choices:
// - Idempotent upsert via PUT /lists/{id}/members/{md5(email)}. Mailchimp's
//   `status_if_new: "pending"` semantics mean already-subscribed contacts
//   keep their status (no spam re-confirmation), and only genuinely new
//   contacts get the double opt-in flow.
// - Backfill cutoff (AUDIENCE_BACKFILL_CUTOFF) prevents the first cron
//   run from emailing thousands of historical customers a confirmation
//   they didn't ask for. The cutoff date represents "this is when the
//   ERP took over from FileMaker as the customer-creation system of
//   record" -- earlier customers are presumed already in Mailchimp via
//   FileMaker.
// - Pure helpers (subscriberHash, buildMemberPayload) live here and are
//   tested independently. Network code is in runCustomerAudienceSync().

import axios, { AxiosError } from "axios";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { logger, logError } from "@/lib/logger";
import { resolveCredential } from "@/lib/integrationCredentials";

// ─── Configuration ──────────────────────────────────────────────────────────

// Customers created on or after this date are eligible for sync.
// Earlier customers are presumed already in Mailchimp via the legacy
// FileMaker integration. Override via env if a different cutoff is needed
// (e.g. running a one-off backfill of an older slice).
export const AUDIENCE_BACKFILL_CUTOFF = new Date(
  process.env.MAILCHIMP_AUDIENCE_BACKFILL_CUTOFF || "2026-04-05",
);

// Tag applied to every customer pushed by this runner. Lines up with the
// existing "Customer" static segment on the configured audience.
export const AUDIENCE_TAG_NEW_CUSTOMER = "Customer";

// Resolved per runner entry (DB-first via Settings, env fallback) by
// ensureConfig(). Module-scoped so the existing BASE_URL / authHeader /
// MAILCHIMP_AUDIENCE_ID references keep working after resolution.
let MAILCHIMP_AUDIENCE_ID = "";
import { mailchimpDatacenter, mailchimpBaseUrl } from "@/lib/mailchimp/baseUrl";

let BASE_URL = "";
let authHeader = { headers: { Authorization: "" } };

const DEFAULT_BATCH_SIZE = 200;
const RATE_LIMIT_DELAY_MS = 5000;
const INTER_REQUEST_DELAY_MS = 200;
const MAX_RATE_LIMIT_RETRIES = 2;

async function ensureConfig(): Promise<void> {
  const apiKey = await resolveCredential("mailchimp", "apiKey", "MAILCHIMP_API_KEY");
  const datacenter = mailchimpDatacenter(apiKey);
  if (!apiKey || !datacenter) {
    throw new Error(
      "Mailchimp not configured: set the Mailchimp API key (format <key>-<datacenter>, " +
        "e.g. xxx-us18) in Settings > Integrations or the MAILCHIMP_API_KEY environment variable.",
    );
  }
  const audienceId = await resolveCredential("mailchimp", "audienceId", "MAILCHIMP_AUDIENCE_ID");
  if (!audienceId) {
    throw new Error(
      "Mailchimp audience not configured: set the Audience ID in Settings > Integrations " +
        "or the MAILCHIMP_AUDIENCE_ID environment variable.",
    );
  }
  MAILCHIMP_AUDIENCE_ID = audienceId;
  BASE_URL = mailchimpBaseUrl(datacenter);
  authHeader = { headers: { Authorization: `apikey ${apiKey}` } };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimit(err: unknown): err is AxiosError {
  return axios.isAxiosError(err) && err.response?.status === 429;
}

function retryAfterMs(err: AxiosError): number {
  const h = err.response?.headers?.["retry-after"];
  return h ? Number.parseInt(String(h), 10) * 1000 : RATE_LIMIT_DELAY_MS;
}

// ─── Pure helpers (tested in mailchimpAudienceSync.test.ts) ─────────────────

/**
 * Mailchimp's subscriber_hash: MD5 of the lowercased email address.
 * Required as the path segment when upserting via PUT.
 * https://mailchimp.com/developer/marketing/api/list-members/add-or-update-list-member/
 */
export function subscriberHash(email: string): string {
  return createHash("md5").update(email.toLowerCase().trim()).digest("hex");
}

export interface MemberPayloadInput {
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface MemberPayload {
  email_address: string;
  status_if_new: "pending";
  merge_fields: {
    FNAME?: string;
    LNAME?: string;
  };
  tags: string[];
}

/**
 * Builds the body for PUT /lists/{id}/members/{hash}. Returns null when
 * the customer has no usable email so the caller can skip cleanly without
 * branching on string-empty checks at every call site.
 */
export function buildMemberPayload(input: MemberPayloadInput): MemberPayload | null {
  const email = input.email?.trim();
  if (!email) return null;
  // Cheap sanity guard -- Mailchimp will reject malformed addresses with a
  // 400, but we'd rather skip silently and not waste the API call.
  if (!email.includes("@") || !email.includes(".")) return null;

  const merge: MemberPayload["merge_fields"] = {};
  if (input.firstName) merge.FNAME = input.firstName.trim();
  if (input.lastName) merge.LNAME = input.lastName.trim();

  return {
    email_address: email,
    status_if_new: "pending",
    merge_fields: merge,
    tags: [AUDIENCE_TAG_NEW_CUSTOMER],
  };
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export interface CustomerAudienceSyncOptions {
  /** Override the per-run cap. Default 200 to stay well below Mailchimp limits. */
  limit?: number;
  /** Dry run -- builds payloads but does not call Mailchimp or update DB. */
  dryRun?: boolean;
}

export interface CustomerAudienceSyncResult {
  scanned: number;
  pushed: number;
  skippedNoEmail: number;
  skippedInvalidEmail: number;
  errors: Array<{ customerId: number; email: string | null; message: string }>;
  dryRun: boolean;
}

interface CustomerCandidate {
  id: number;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Extracts a human-readable error message from an axios / Error / unknown
 * thrown value. Replaces a nested ternary that Sonar rule S3358 flagged.
 * Exported for unit-testing in isolation.
 */
export function describeSyncError(err: unknown): string {
  if (axios.isAxiosError(err) && err.response?.data) {
    return JSON.stringify(err.response.data).slice(0, 300);
  }
  if (err instanceof Error) {
    return err.message;
  }
  return "unknown error";
}

/**
 * Marks a customer as synced (timestamp = now). Used for both successful
 * pushes AND malformed-email skips so they don't churn next run.
 */
async function markCustomerSynced(customerId: number): Promise<void> {
  await prisma.customer.update({
    where: { id: customerId },
    data: { mailchimpSyncedAt: new Date() },
  });
}

/**
 * Pushes a single customer payload to Mailchimp with rate-limit retry.
 * Returns the outcome -- caller updates the result object accordingly.
 * Extracted from runCustomerAudienceSync to keep cognitive complexity
 * below the Sonar S3776 threshold.
 */
async function pushSingleCustomer(
  customer: CustomerCandidate,
  payload: MemberPayload,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const url = `${BASE_URL}/lists/${MAILCHIMP_AUDIENCE_ID}/members/${subscriberHash(
    payload.email_address,
  )}`;

  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
    try {
      await axios.put(url, payload, authHeader);
      await markCustomerSynced(customer.id);
      return { ok: true };
    } catch (err: unknown) {
      if (isRateLimit(err) && attempt < MAX_RATE_LIMIT_RETRIES) {
        const wait = retryAfterMs(err);
        logger.warn(`Mailchimp rate limited, sleeping ${wait}ms`);
        await sleep(wait);
        continue;
      }
      logError(`Mailchimp customer sync failed for ${customer.email}`, err);
      return { ok: false, message: describeSyncError(err) };
    }
  }

  // Unreachable, but TypeScript needs an explicit terminal return.
  return { ok: false, message: "exceeded retry attempts" };
}

/**
 * Pushes the next batch of unsynced customers (created on/after the
 * backfill cutoff) into the configured Mailchimp audience as PENDING
 * (double-opt-in). Idempotent -- repeated runs converge.
 */
export async function runCustomerAudienceSync(
  opts: CustomerAudienceSyncOptions = {},
): Promise<CustomerAudienceSyncResult> {
  await ensureConfig();
  const limit = opts.limit ?? DEFAULT_BATCH_SIZE;
  const dryRun = opts.dryRun === true;

  const candidates = await prisma.customer.findMany({
    where: {
      mailchimpSyncedAt: null,
      email: { not: null },
      created: { gte: AUDIENCE_BACKFILL_CUTOFF },
    },
    select: { id: true, email: true, firstName: true, lastName: true },
    orderBy: { created: "asc" },
    take: limit,
  });

  const result: CustomerAudienceSyncResult = {
    scanned: candidates.length,
    pushed: 0,
    skippedNoEmail: 0,
    skippedInvalidEmail: 0,
    errors: [],
    dryRun,
  };

  for (const customer of candidates) {
    if (!customer.email) {
      result.skippedNoEmail += 1;
      continue;
    }

    const payload = buildMemberPayload({
      email: customer.email,
      firstName: customer.firstName,
      lastName: customer.lastName,
    });

    if (!payload) {
      result.skippedInvalidEmail += 1;
      // Mark synced anyway -- a malformed email will never succeed and we
      // don't want it churning back into the working set every run.
      if (!dryRun) await markCustomerSynced(customer.id);
      continue;
    }

    if (dryRun) {
      result.pushed += 1;
      continue;
    }

    const outcome = await pushSingleCustomer(customer, payload);
    if (outcome.ok) {
      result.pushed += 1;
    } else {
      result.errors.push({
        customerId: customer.id,
        email: customer.email,
        message: outcome.message,
      });
    }

    await sleep(INTER_REQUEST_DELAY_MS);
  }

  return result;
}
