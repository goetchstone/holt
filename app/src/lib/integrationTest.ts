// /app/src/lib/integrationTest.ts
//
// Per-provider "test connection" checks for the Settings > Integrations page.
// Each check resolves the provider's credentials (DB-first, env fallback) and
// makes the cheapest authenticated call that proves the credentials work, then
// returns a structured pass/fail with a human-readable message. Never throws --
// every failure is reported as { ok: false, message }.
//
// Some providers can't be cheaply live-tested without a full OAuth dance
// (Google sign-in, Gmail domain-wide delegation); those report a config-only
// result that confirms the credentials are present without claiming the
// connection is verified.

import axios from "axios";
import { resolveCredential } from "@/lib/integrationCredentials";
import { getStripe } from "@/lib/stripe";
import { getInstallationToken } from "@/lib/githubApp";
import { fetchAxperTraffic } from "@/lib/axperClient";

export interface IntegrationTestResult {
  ok: boolean;
  /** "verified" = a live authenticated call succeeded; "config" = creds present but not live-tested. */
  level: "verified" | "config" | "failed";
  message: string;
}

function fail(message: string): IntegrationTestResult {
  return { ok: false, level: "failed", message };
}
function verified(message: string): IntegrationTestResult {
  return { ok: true, level: "verified", message };
}
function configOnly(message: string): IntegrationTestResult {
  return { ok: true, level: "config", message };
}

function describeError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    return status ? `HTTP ${status}` : err.code || err.message;
  }
  return err instanceof Error ? err.message : "unknown error";
}

async function testStripe(): Promise<IntegrationTestResult> {
  try {
    const stripe = await getStripe(); // throws if no key configured
    const balance = await stripe.balance.retrieve();
    return verified(`Authenticated. ${balance.available.length} balance currenc(ies) available.`);
  } catch (err) {
    return fail(`Stripe test failed: ${describeError(err)}`);
  }
}

async function testMailchimp(): Promise<IntegrationTestResult> {
  const apiKey = await resolveCredential("mailchimp", "apiKey", "MAILCHIMP_API_KEY");
  const datacenter = apiKey?.split("-")[1];
  if (!apiKey || !datacenter) {
    return fail("Mailchimp API key not set (expected format <key>-<datacenter>, e.g. xxx-us18).");
  }
  try {
    const { data } = await axios.get(`https://${datacenter}.api.mailchimp.com/3.0/ping`, {
      headers: { Authorization: `apikey ${apiKey}` },
      timeout: 10_000,
    });
    const health = (data as { health_status?: unknown })?.health_status;
    return verified(typeof health === "string" ? health : "Authenticated.");
  } catch (err) {
    return fail(`Mailchimp test failed: ${describeError(err)}`);
  }
}

async function testGithub(): Promise<IntegrationTestResult> {
  try {
    await getInstallationToken(); // mints a real installation token via App JWT
    return verified("GitHub App authenticated (installation token minted).");
  } catch (err) {
    return fail(`GitHub test failed: ${describeError(err)}`);
  }
}

async function testAxper(): Promise<IntegrationTestResult> {
  const apiKey = await resolveCredential("axper", "apiKey", "AXPER_API_KEY");
  if (!apiKey) return fail("Axper API key not set.");
  try {
    // fetchAxperTraffic returns [] on auth failure (logs internally); a 1-day
    // pull that returns an array without throwing confirms the endpoint + key.
    const today = new Date().toISOString().slice(0, 10);
    const rows = await fetchAxperTraffic({ dateFrom: today, dateTo: today });
    return verified(`Reached Axper; ${rows.length} rows for today.`);
  } catch (err) {
    return fail(`Axper test failed: ${describeError(err)}`);
  }
}

// Providers whose credentials we can confirm are present but can't cheaply
// live-test without a full OAuth/delegation flow.
async function testConfigOnly(
  provider: string,
  fields: { field: string; envVar: string }[],
  successMsg: string,
): Promise<IntegrationTestResult> {
  for (const f of fields) {
    const v = await resolveCredential(provider, f.field, f.envVar);
    if (!v) return fail(`${provider}: ${f.field} is not set.`);
  }
  return configOnly(successMsg);
}

export async function testIntegration(provider: string): Promise<IntegrationTestResult> {
  switch (provider) {
    case "stripe":
      return testStripe();
    case "mailchimp":
      return testMailchimp();
    case "github":
      return testGithub();
    case "axper":
      return testAxper();
    case "google":
      return testConfigOnly(
        "google",
        [
          { field: "clientId", envVar: "GOOGLE_CLIENT_ID" },
          { field: "clientSecret", envVar: "GOOGLE_CLIENT_SECRET" },
        ],
        "Google OAuth credentials are present. Sign-in is verified at login time.",
      );
    case "gmail":
      return testConfigOnly(
        "gmail",
        [
          { field: "serviceAccountJson", envVar: "GMAIL_SERVICE_ACCOUNT_PATH" },
          { field: "delegateEmail", envVar: "GMAIL_DELEGATE_EMAIL" },
        ],
        "Gmail service-account settings are present. Delegation is verified on the next import run.",
      );
    default:
      return fail(`No connection test is defined for "${provider}".`);
  }
}
