// /app/src/server/trpc/routers/chat.ts
//
// The AI data-chatbot endpoint. Router style mirrors routers/reports.ts: zod
// input, defer to a lib/* function (lib/ai/askData.ts) so the data + safety
// logic stays framework-agnostic and testable without tRPC.
//
// It is a mutation, not a query, because each ask runs a fresh model call +
// database read with side effects (statement-timeout'd SELECT) and must never
// be cached or prefetched by react-query the way a report is.
//
// GATING: protectedProcedure (signed-in) only, for now. A module/permission
// gate -- the `ai` module flag from lib/modules/registry.ts, via requireModule
// / a permissionProcedure -- lands in a later phase alongside the settings UI;
// phase 1 is backend-only and the endpoint is not yet wired to any nav.

import { z } from "zod";
import { askData } from "@/lib/ai/askData";
import { router, protectedProcedure } from "../trpc";

export const chatRouter = router({
  ask: protectedProcedure
    .input(z.object({ question: z.string().min(1) }))
    .mutation(({ input }) => askData(input.question)),
});
