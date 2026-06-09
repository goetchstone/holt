// /app/src/app/api/trpc/[trpc]/route.ts
//
// HTTP entry point for all tRPC calls (App Router fetch adapter). Lives
// alongside the legacy Pages Router /api/* routes during the migration; new
// procedures land under /api/trpc, old REST endpoints keep working until each
// domain is ported.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "@/server/trpc/routers/_app";
import { createContext } from "@/server/trpc/context";

function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext({ req }),
  });
}

export { handler as GET, handler as POST };
