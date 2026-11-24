// /app/__tests__/trpcProcedureAuthorization.test.ts
//
// Every tRPC procedure must AUTHORIZE, not merely authenticate. The tRPC half
// of the manifest the Pages Router already has: apiRouteAuthorization.test.ts
// (mutating routes) and apiReadRouteAuthorization.test.ts (reads) fail on a
// route that checks only that somebody is signed in. The tRPC layer had no such
// check, and three report reads (tax summary, sales performance, the legacy
// archive) shipped session-only: any signed-in user of any role reached them.
// Rule 65: a set that must stay covered gets a manifest and a tripwire.
//
// HOW IT ENUMERATES. It imports the real appRouter and walks
// `appRouter._def.procedures` (a flat map of "router.procedure" paths), so a new
// router or procedure is in the population the moment it is mounted; nothing is
// hand-listed. (Importing needs no database: the Prisma client connects lazily,
// and trpcHealthRouter.test.ts already loads this router in the unit project.)
//
// HOW IT CLASSIFIES. trpc.ts exports `authMiddlewareMarkers`: the session
// middleware, and a set holding the gate middleware that roleProcedure and
// permissionProcedure create. A procedure whose `_def.middlewares` holds a gate
// is gated; one holding only the session middleware is protected; neither is
// public. (Counting middlewares does not work: a procedure's input and resolver
// steps are middlewares too.) A guard test proves the builders are distinguishable.
//
// FAILS IN BOTH DIRECTIONS:
//   - a public or session-only procedure not in ALLOWED fails (a new ungated one);
//   - an ALLOWED entry that no longer exists, or is now gated, fails as stale
//     (the list would otherwise lie about how much is open, or un-guard whatever
//     reuses the name).

import { appRouter } from "@/server/trpc/routers/_app";
import {
  authMiddlewareMarkers,
  protectedProcedure,
  publicProcedure,
  permissionProcedure,
  roleProcedure,
} from "@/server/trpc/trpc";

type Tier = "public" | "protected" | "gated";
interface Allowed {
  tier: "public" | "protected";
  reason: string;
}

/**
 * Procedures that legitimately stop short of a role or permission gate. Keep it
 * short and argued: an entry here is a procedure nobody looks at again. The
 * reason says what makes it safe, or "OPEN" when it is debt awaiting a decision.
 */
const ALLOWED: Record<string, Allowed> = {
  "health.ping": {
    tier: "public",
    reason: "Liveness probe; returns a constant { ok: true } and reads nothing.",
  },
  "health.me": {
    tier: "protected",
    reason: "Echoes the caller's own session user id back; touches no other data.",
  },
  "account.me": {
    tier: "protected",
    reason:
      "Self-scoped: reads only the caller's own staff row, keyed by the session userId, never client input. Every signed-in user needs their own account screen, so no permission applies.",
  },
  "account.changePassword": {
    tier: "protected",
    reason:
      "Self-scoped: changes only the session user's own password, and re-verifies the current password first.",
  },
  "account.setFollowUpEmail": {
    tier: "protected",
    reason: "Self-scoped: flips only the session user's own follow-up email preference.",
  },
  "account.setTagPrintMode": {
    tier: "protected",
    reason: "Self-scoped: sets only the session user's own tag print mode.",
  },
  "account.setPin": {
    tier: "protected",
    reason:
      "Self-scoped: sets only the session user's own manager PIN, after re-verifying their password, and writes an audit row.",
  },
};

type Middleware = unknown;
const middlewaresOf = (proc: unknown): Middleware[] =>
  (proc as { _def: { middlewares: Middleware[] } })._def.middlewares;

function tierOf(proc: unknown): Tier {
  const mws = middlewaresOf(proc);
  if (mws.some((m) => authMiddlewareMarkers.gates.has(m as object))) return "gated";
  if (mws.includes(authMiddlewareMarkers.session)) return "protected";
  return "public";
}

function allProcedures(): Record<string, Tier> {
  const procs = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
    .procedures;
  return Object.fromEntries(Object.entries(procs).map(([path, p]) => [path, tierOf(p)]));
}

describe("tRPC procedures authorize, not just authenticate", () => {
  it("the classifier can tell the tiers apart (the instrument can disagree)", () => {
    // If a refactor made protectedProcedure and the gated builders look alike,
    // every other assertion here would pass vacuously.
    expect(tierOf(publicProcedure)).toBe("public");
    expect(tierOf(protectedProcedure)).toBe("protected");
    expect(tierOf(roleProcedure(["ADMIN"]))).toBe("gated");
    expect(tierOf(permissionProcedure("reporting.read"))).toBe("gated");
  });

  it("enumerates a real population", () => {
    const procs = allProcedures();
    expect(Object.keys(procs).length).toBeGreaterThan(50);
    expect(procs["reports.taxSummary"]).toBe("gated");
  });

  it("no procedure is public or session-only unless listed with a reason", () => {
    const offenders = Object.entries(allProcedures())
      .filter(([, tier]) => tier !== "gated")
      .filter(([path, tier]) => ALLOWED[path]?.tier !== tier)
      .map(([path, tier]) => `${path} (${tier})`);

    // Failing here means a NEW procedure ships that any signed-in user (or
    // anyone) can call, or a gate was torn off one that had it. For a new
    // procedure: use permissionProcedure(key) with the key of the screen that
    // calls it, copied from that page's requirePage(undefined, { permission })
    // or a sibling API route, rather than inventing a key. Only a procedure
    // that is truly self-scoped or public goes in ALLOWED, with the reason it
    // is safe.
    expect(offenders).toEqual([]);
  });

  it("ALLOWED has no stale entries", () => {
    // An entry whose procedure was deleted, renamed, or has since been gated
    // would silently un-guard whatever reuses the name. Shrinking this list is
    // the point, so it has to stay honest.
    const procs = allProcedures();
    const gone = Object.keys(ALLOWED).filter((p) => !(p in procs));
    const nowGated = Object.keys(ALLOWED).filter((p) => procs[p] === "gated");
    const wrongTier = Object.keys(ALLOWED).filter(
      (p) => procs[p] && procs[p] !== "gated" && procs[p] !== ALLOWED[p].tier,
    );
    expect({ gone, nowGated, wrongTier }).toEqual({ gone: [], nowGated: [], wrongTier: [] });
  });

  it("every entry carries a written reason", () => {
    for (const [path, entry] of Object.entries(ALLOWED)) {
      expect({ path, ok: entry.reason.trim().length >= 30 }).toEqual({ path, ok: true });
    }
  });
});

// The 2026-11 role-list sweep moved the last roleProcedure callers (the reports,
// billing and client-portal routers) onto permission keys, which a store sets in
// Roles; a role list is a hardcoded set of staff enum values it cannot. The
// checks above count roleProcedure as gated, so a new one would pass them. This
// holds the routers at none: roleProcedure stays for tests that pin the shared
// role-list decision, and a router that needs a gate takes a key.
describe("no procedure is gated by a role list", () => {
  const onRoleList = (proc: unknown) =>
    middlewaresOf(proc).some((m) => authMiddlewareMarkers.roleLists.has(m as object));

  it("the marker tells a role list from a permission key (the instrument can disagree)", () => {
    expect(onRoleList(roleProcedure(["MANAGER", "ADMIN"]))).toBe(true);
    expect(onRoleList(permissionProcedure("reporting.read"))).toBe(false);
    expect(onRoleList(protectedProcedure)).toBe(false);
  });

  it("finds no mounted procedure built with roleProcedure", () => {
    const procs = (appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def
      .procedures;
    expect(Object.keys(procs).length).toBeGreaterThan(50);
    expect(
      Object.entries(procs)
        .filter(([, proc]) => onRoleList(proc))
        .map(([path]) => path),
    ).toEqual([]);
  });
});
