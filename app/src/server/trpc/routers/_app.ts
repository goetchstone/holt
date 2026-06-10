// /app/src/server/trpc/routers/_app.ts
//
// Root tRPC router for the merged product. Domain routers get mounted here as
// the migration ports each vertical (sales, inventory, dispatch, …). For now it
// carries only the health router used to prove the wiring end-to-end (F3).

import { router, publicProcedure, protectedProcedure } from "../trpc";
import { reportsRouter } from "./reports";
import { billingRouter } from "./billing";
import { legacyArchiveRouter } from "./legacyArchive";

const healthRouter = router({
  // Liveness: confirms the tRPC HTTP route + transformer are working.
  ping: publicProcedure.query(() => ({ ok: true as const })),
  // Confirms the auth context resolves the signed-in user's id.
  me: protectedProcedure.query(({ ctx }) => ({ userId: ctx.userId })),
});

export const appRouter = router({
  health: healthRouter,
  reports: reportsRouter,
  billing: billingRouter,
  legacyArchive: legacyArchiveRouter,
});

export type AppRouter = typeof appRouter;
