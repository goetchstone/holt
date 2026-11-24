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
//   (a) wrap its handler in requireAuthWithRole([...]) or
//       requirePermission("domain.action", ...), or
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
  "sms/twilio/webhook.ts":
    "Twilio's delivery endpoint for STOP replies and delivery reports; its X-Twilio-Signature IS the authorization, no staff session exists",

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
        // Either shape counts as an explicit decision. requirePermission is
        // where these are headed -- it gates on a capability from
        // permissionCatalog.ts rather than a job title -- and both wrappers
        // resolve the staff row from the database per request and share the
        // same impersonation and bootstrap rules, so neither is the weaker
        // check. A route that has moved must not read as an offender here.
        // guardAutomation wraps requirePermission("admin.automations", ...) with a
        // service-key bypass for the scheduler, so a route that uses it IS gated on
        // a capability -- it just names the wrapper instead of the primitive.
        hasRoleGate: /requireAuthWithRole\s*\(|requirePermission\s*\(|guardAutomation\s*\(/.test(
          src,
        ),
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
          "Each must either wrap its handler in requireAuthWithRole([...]) or\n" +
          'requirePermission("domain.action", ...), or be\n' +
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

// A route whose default export is a plain function that branches on req.method
// (inventory/freeze/index.ts, warehouse/locations/index.ts) is only as gated as
// its weakest branch. The checks above look for a gate ANYWHERE in the file, so
// a branch that drops its gate would still pass them. Here every branch must
// return through a gate, through a local const built from one
// (`const listTickets = requireAuthWithRole(...)`), or be public by design with
// a reason below.
const DISPATCH_GATE = /^(requirePermission|requireAuthWithRole|requireAuth|guardAutomation)$/;
const PUBLIC_METHODS_BY_DESIGN: Record<string, string> = {
  "tickets/index.ts POST": "the public /support form opens a ticket; rate-limited",
  "bookings/index.ts POST": "the public /book flow creates a booking; rate-limited, race-guarded",
  "tickets/public/[token].ts GET":
    "no-login ticket view; the ticket's publicToken is the capability",
  "tickets/public/[token].ts POST":
    "the customer replies on their ticket; publicToken is the capability; rate-limited",
};

interface DispatchBranch {
  key: string;
  callee: string;
  gated: boolean;
}

/** A route whose default export is a plain function: its body, and the local
 *  consts built from a gate that the body may return through. */
interface Dispatcher {
  rel: string;
  body: string;
  gatedLocals: ReadonlySet<string>;
}

async function dispatchers(): Promise<Dispatcher[]> {
  const out: Dispatcher[] = [];
  for (const file of await walk(API_ROOT)) {
    const src = await fs.readFile(file, "utf8");
    const body = /export default (?:async )?function\s*\w*\s*\([^)]*\)[^{]*\{([\s\S]*?)\n\}\n/.exec(
      src,
    );
    if (!body) continue;
    const gatedLocals = new Set(
      [...src.matchAll(/const\s+(\w+)\s*=\s*(\w+)\s*\(/g)]
        .filter(([, , fn]) => DISPATCH_GATE.test(fn))
        .map(([, name]) => name),
    );
    out.push({ rel: path.relative(API_ROOT, file), body: body[1], gatedLocals });
  }
  return out;
}

async function dispatchBranches(): Promise<DispatchBranch[]> {
  const out: DispatchBranch[] = [];
  for (const { rel, body, gatedLocals } of await dispatchers()) {
    const branch =
      /if\s*\(\s*req\.method\s*===\s*["'](\w+)["']\s*\)\s*\{?\s*return\s+([\w.]+)\s*\(/g;
    for (const [, method, callee] of body.matchAll(branch)) {
      out.push({
        key: `${rel} ${method}`,
        callee,
        gated: DISPATCH_GATE.test(callee) || gatedLocals.has(callee),
      });
    }
  }
  return out;
}

describe("per-method dispatch", () => {
  it("finds the dispatcher routes it is meant to check", async () => {
    // A floor, so a pattern that matches nothing cannot pass silently.
    expect((await dispatchBranches()).length).toBeGreaterThanOrEqual(12);
  });

  it("every branch returns through a gate, or is public by design", async () => {
    const offenders = (await dispatchBranches())
      .filter((b) => !b.gated && !(b.key in PUBLIC_METHODS_BY_DESIGN))
      .map((b) => `${b.key} -> ${b.callee}(...)`);
    expect(offenders).toEqual([]);
  });

  it("the public-by-design list has no stale entries", async () => {
    const ungated = new Set((await dispatchBranches()).filter((b) => !b.gated).map((b) => b.key));
    expect(Object.keys(PUBLIC_METHODS_BY_DESIGN).filter((k) => !ungated.has(k))).toEqual([]);
  });
});

// The branch check sees only `if (req.method === "X") return ...` lines. A
// dispatcher's LAST statement is the one that runs for every method no branch
// took, so in `if (GET) return readGate(...); return writeGate(...);` it is the
// whole write path, and it is not a branch. The route-level check above passes
// on the read gate alone, so a last line that called the handler bare passed
// every check here (service/settings/statuses.ts, 2026-11-21). So the last
// statement of every default-export function that reads req.method must return
// through a gate, or refuse the method with a 405, or be argued for below. A
// file on UNGATED_BY_DESIGN is public as a whole and needs no entry. Which gate
// is a behavioural question this cannot answer (returning the read gate passes
// here); the route's own tests refuse it a write with a role that passes its
// read gate (serviceRouteKeys, accountingBillingGates).
const LAST_STATEMENT_BY_DESIGN: Record<string, string> = {
  "uploads/[...path].ts":
    "not a dispatcher: one inline GET handler that answers every other method 405 first; public upload folders are served without a session, the rest only to a signed-in one",
};

/** The body's last top-level statement. Prettier indents the body's statements
 *  two spaces; deeper lines, closing brackets and comments belong to one. */
function lastStatement(body: string): string {
  const lines = body.split("\n");
  let start = -1;
  lines.forEach((line, i) => {
    if (/^ {2}(?![\s)\]}]|\/\/|\/\*|\*)/.test(line)) start = i;
  });
  return start === -1 ? "" : lines.slice(start).join("\n").trim();
}

/** Does this body end by returning through a gate, or by refusing the method? */
function endsGated(body: string, gatedLocals: ReadonlySet<string>): boolean {
  const last = lastStatement(body);
  if (/^return\s+(?:res\.status\(\s*405\s*\)|methodNotAllowed\()/.test(last)) return true;
  const callee = /^return\s+([\w.]+)\s*\(/.exec(last)?.[1];
  return callee !== undefined && (DISPATCH_GATE.test(callee) || gatedLocals.has(callee));
}

async function methodReaders(): Promise<Dispatcher[]> {
  return (await dispatchers()).filter(
    (d) => /\breq\.method\b/.test(d.body) && !(d.rel in UNGATED_BY_DESIGN),
  );
}

describe("a dispatcher's last statement", () => {
  it("finds the dispatchers it is meant to check", async () => {
    // A floor, so a pattern that matches nothing cannot pass silently. 39 on
    // 2026-11-21, nine of them ending `return writeGate(req, res)` or the like.
    const found = await methodReaders();
    expect(found.length).toBeGreaterThanOrEqual(35);
    expect(found.map((d) => d.rel)).toContain("service/settings/statuses.ts");
  });

  it("returns through a gate, or refuses the method", async () => {
    const offenders = (await methodReaders())
      .filter((d) => !endsGated(d.body, d.gatedLocals) && !(d.rel in LAST_STATEMENT_BY_DESIGN))
      .map((d) => `${d.rel}: ${lastStatement(d.body).split("\n")[0]}`);
    expect(offenders).toEqual([]);
  });

  it("the by-design list has no stale entries, and every entry states a reason", async () => {
    const ungated = new Set(
      (await methodReaders()).filter((d) => !endsGated(d.body, d.gatedLocals)).map((d) => d.rel),
    );
    expect(Object.keys(LAST_STATEMENT_BY_DESIGN).filter((rel) => !ungated.has(rel))).toEqual([]);
    for (const reason of Object.values(LAST_STATEMENT_BY_DESIGN)) {
      expect(reason.length).toBeGreaterThan(25);
    }
  });

  it("would fail on any of them whose last line called the handler bare", async () => {
    // The check proven able to fail, on every route it passes: each copy has
    // its last statement swapped for `return handler(req, res);`.
    const passing = (await methodReaders()).filter((d) => endsGated(d.body, d.gatedLocals));
    const missed = passing
      .filter((d) => {
        const last = lastStatement(d.body);
        const bare = `${d.body.slice(0, d.body.lastIndexOf(last))}return handler(req, res);`;
        return endsGated(bare, d.gatedLocals);
      })
      .map((d) => d.rel);
    expect(passing.length).toBeGreaterThanOrEqual(35);
    expect(missed).toEqual([]);
  });
});
