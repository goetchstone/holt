// /app/__tests__/apiRouteAuthorization.test.ts
//
// Tripwire: every MUTATING Pages Router API route must make an explicit
// authorization decision.
//
// Why a test rather than a convention: an audit found 146 mutating routes that
// checked only "is this request signed in" and never "is this person allowed"
// -- including issuing card refunds and editing staff records. A signed-in
// DESIGNER could refund a card. That is not a bug in any one route, it is the
// absence of a rule with teeth, so the rule lives here where CI enforces it
// (docs/FRAMEWORK.md: a hard rule belongs in a hard place).
//
// The rule: a route file that handles POST/PUT/PATCH/DELETE must either
//   (a) wrap its handler in requireAuthWithRole([...]), or
//   (b) appear in UNGATED_BY_DESIGN below with a stated reason.
//
// (b) is deliberately noisy to add to. Adding a line here is a security
// decision and should read like one in review.

import { promises as fs } from "node:fs";
import path from "node:path";

const API_ROOT = path.resolve(__dirname, "..", "src", "pages", "api");

/**
 * Routes that mutate but intentionally do NOT take a staff role gate.
 * Every entry states what authorizes it instead -- there is always something.
 */
const UNGATED_BY_DESIGN: Record<string, string> = {
  // --- Unauthenticated by necessity: authorization is cryptographic ---
  "auth/[...nextauth].ts": "NextAuth's own handler; it IS the auth system",

  // --- Public surfaces: rate-limited + validated, no session exists yet ---
  "auth/forgot-password.ts":
    "Public password-reset request; rate-limited, always returns ok:true to avoid account enumeration, 404s when local auth is disabled",
  "auth/reset-password.ts":
    "Public password-reset consumption; the single-use, expiring reset token IS the authorization, not a session",
  "lead-magnet.ts":
    "Public CMS lead-capture form; rate-limited with a honeypot field, no session exists at signup time",
  "comments/index.ts":
    "Public blog comment submission; rate-limited, feature-gated, lands PENDING until a moderator approves it",
  "tools/dmarc-check.ts":
    "Public marketing tool at /tools/dmarc-check; rate-limited per IP, no staff session exists",

  // --- Webhooks: cryptographic signature verification is the authorization ---
  "stripe/webhook.ts":
    "Stripe webhook; the signature verified against the raw body IS the authorization, no staff session exists",
  "square/webhook.ts":
    "Square webhook; the signature verified against the raw body IS the authorization, no staff session exists",

  // --- Customer-portal surfaces: authorized as a CUSTOMER via a capability token, not staff ---
  "portal/pay.ts":
    "Customer portal payment; verifyPortalToken's signed JWT IS the authorization, rate-limited, no staff session",
  "portal/returns/request.ts":
    "Customer portal return request; the portalToken on the Return record IS the authorization, rate-limited, no staff session",
  "client-portal/pay.ts":
    "Client-portal payment; verifyClientPortalToken's capability token scopes the customer to their own invoice, rate-limited, no staff session",
  "tickets/public/[token].ts":
    "No-login public ticket view/reply; the ticket's stable publicToken IS the authorization, rate-limited, internal notes filtered out",
  "tickets/public/[token]/attachment.ts":
    "Customer attaches a file to their own ticket; same publicToken capability as the status/reply endpoint, rate-limited",

  // --- Automation/cron endpoints: authorized by a Bearer token or a scoped session role, not a blanket staff gate ---
  "automations/daily-reconciliation.ts":
    "Bearer AUTO_IMPORT_API_KEY for the Synology cron OR any authenticated session for the admin 'Run Now' UI; non-destructive reconciliation reporting",
  "automations/axper-traffic-sync.ts":
    "Bearer AUTO_IMPORT_API_KEY for the Synology cron OR any authenticated session for the admin 'Run Now' UI, same isAuthorized() pattern as daily-reconciliation.ts",
  "automations/customer-ar-drift-check.ts":
    "Bearer AUTO_IMPORT_API_KEY for the Synology cron OR any authenticated session for the admin 'Run Now' UI, same isAuthorized() pattern as daily-reconciliation.ts",
  "automations/lead-housekeeping.ts":
    "Bearer AUTO_IMPORT_API_KEY for the Synology cron OR any authenticated session for the admin 'Run Now' UI, same isAuthorized() pattern as daily-reconciliation.ts",
  "automations/mailchimp-sync.ts":
    "Bearer AUTO_IMPORT_API_KEY for the Synology cron (scripts/auto-mailchimp-sync.sh) OR any authenticated session for the admin 'Run Now' UI",
  "automations/mailchimp-customer-sync.ts":
    "Bearer AUTO_IMPORT_API_KEY for the Synology cron (scripts/auto-mailchimp-customer-sync.sh) OR any authenticated session for the admin 'Run Now' UI",
  "automations/customer-level-recalc.ts":
    "Bearer AUTO_IMPORT_API_KEY for the Synology cron (scripts/auto-customer-level-recalc.sh) OR an ADMIN/MANAGER/SUPER_ADMIN session role checked in isAuthorized() -- stricter than the other automations, which accept any session",
  "mailchimp/backfill-customer-links.ts":
    "Bearer AUTO_IMPORT_API_KEY OR an ADMIN/MANAGER/SUPER_ADMIN session role checked in isAuthorized() -- same dual-auth mechanism as automations/customer-level-recalc.ts, triggered from the same admin mailchimp-sync UI though the route lives outside api/automations/*",
  "automations/expire-stale-pending-payments.ts":
    "Bearer AUTO_IMPORT_API_KEY for the Synology cron OR any authenticated session for manual triggering, same isAuthorized() pattern as daily-reconciliation.ts -- only ever marks an already-abandoned PENDING row FAILED (no ledger entry, nothing reversible), strictly less destructive than the MANAGER/ADMIN-gated manual void endpoint",
};

/** Files that are helpers/config, not routes. */
const NOT_A_ROUTE = /\.(test|spec)\.ts$|^_/;

const MUTATING_METHOD = /"(POST|PUT|PATCH|DELETE)"|'(POST|PUT|PATCH|DELETE)'/;

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.name.endsWith(".ts") && !NOT_A_ROUTE.test(e.name)) out.push(full);
  }
  return out;
}

interface RouteAudit {
  rel: string;
  mutates: boolean;
  hasRoleGate: boolean;
  hasBareAuth: boolean;
}

async function auditRoutes(): Promise<RouteAudit[]> {
  const files = await walk(API_ROOT);
  return Promise.all(
    files.map(async (file) => {
      const src = await fs.readFile(file, "utf8");
      return {
        rel: path.relative(API_ROOT, file),
        // A route "mutates" if it names a mutating method anywhere -- method
        // dispatch in this codebase is always a string comparison against
        // req.method, so this is a reliable over-approximation. Over- rather
        // than under-approximating is the right error to make here.
        mutates: MUTATING_METHOD.test(src),
        hasRoleGate: /requireAuthWithRole\s*\(/.test(src),
        hasBareAuth: /requireAuth\s*\(/.test(src),
      };
    }),
  );
}

describe("API route authorization", () => {
  it("every mutating route makes an explicit role decision", async () => {
    const routes = await auditRoutes();
    const offenders = routes
      .filter((r) => r.mutates && !r.hasRoleGate && !(r.rel in UNGATED_BY_DESIGN))
      .map((r) => r.rel)
      .sort();

    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} mutating API route(s) have no role gate.\n\n` +
          "Each must either wrap its handler in requireAuthWithRole([...]) or be\n" +
          "added to UNGATED_BY_DESIGN in this file WITH a reason.\n\n" +
          "A signed-in user with any role can currently call these:\n" +
          offenders.map((o) => `  - ${o}`).join("\n"),
      );
    }
  });

  it("the ungated allowlist has no stale entries", async () => {
    // A route that gains a role gate, or is deleted, must drop off the list --
    // otherwise the allowlist slowly becomes a lie and stops meaning anything.
    const routes = await auditRoutes();
    const byRel = new Map(routes.map((r) => [r.rel, r]));

    const stale = Object.keys(UNGATED_BY_DESIGN).filter((rel) => {
      const r = byRel.get(rel);
      return !r || !r.mutates || r.hasRoleGate;
    });

    expect(stale).toEqual([]);
  });

  it("every allowlist entry states a reason", () => {
    const unexplained = Object.entries(UNGATED_BY_DESIGN)
      .filter(([, reason]) => !reason || reason.trim().length < 15)
      .map(([rel]) => rel);
    expect(unexplained).toEqual([]);
  });
});
