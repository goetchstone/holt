// /app/src/app/api/trpc/[trpc]/route.ts
//
// HTTP entry point for all tRPC calls (App Router fetch adapter). Lives
// alongside the legacy Pages Router /api/* routes during the migration; new
// procedures land under /api/trpc, old REST endpoints keep working until each
// domain is ported.
//
// The onError hook is not optional decoration. Without it this adapter
// swallows every failure it handles, which meant the entire invoicing and
// reporting layer -- everything ported to tRPC so far -- failed silently in
// production: no log line, no alert, nothing durable. A procedure could throw
// on every call for a week and the only evidence would be a user saying "the
// report is blank".

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { TRPCError } from "@trpc/server";

import { appRouter } from "@/server/trpc/routers/_app";
import { createContext } from "@/server/trpc/context";
import { logError } from "@/lib/logger";

/**
 * Codes that describe a CLIENT mistake, not a system fault. A 404 or a
 * rejected login is the app working correctly; recording them would bury the
 * real incidents under routine traffic and train everyone to ignore the
 * alerts. Anything else -- above all INTERNAL_SERVER_ERROR -- is ours.
 */
const EXPECTED_CLIENT_ERRORS = new Set<TRPCError["code"]>([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "TOO_MANY_REQUESTS",
]);

function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext({ req }),
    onError({ error, path, type }) {
      if (EXPECTED_CLIENT_ERRORS.has(error.code)) return;

      // `error.cause` is the original throw; `error` is tRPC's wrapper, whose
      // stack points at the framework rather than at our code. Passing the
      // cause through keeps the fingerprint on the real call site.
      logError(`tRPC ${type} ${path ?? "<unknown>"} failed`, error.cause ?? error, {
        trpcPath: path,
        trpcType: type,
        trpcCode: error.code,
      });
    },
  });
}

export { handler as GET, handler as POST };
