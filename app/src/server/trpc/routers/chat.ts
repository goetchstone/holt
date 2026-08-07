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
// GATING: reporting.read, via permissionProcedure.
//
// "Signed in" is not enough for this one. The assistant turns a sentence into a
// SELECT over the business's own tables, so whoever can call it can read
// anything the deny list in lib/ai/tableAccess.ts does not exclude -- every
// customer, every order, every payment -- regardless of what the UI would show
// them. Asking a question in English is a reporting capability, so it is gated
// like one.
//
// The permission is the second of two controls and they are not
// interchangeable: this one decides WHO may ask, tableAccess.ts decides WHAT
// any question can reach. Neither is sufficient alone.

import { z } from "zod";
import { askData } from "@/lib/ai/askData";
import { router, permissionProcedure } from "../trpc";

export const chatRouter = router({
  ask: permissionProcedure("reporting.read")
    .input(z.object({ question: z.string().min(1) }))
    .mutation(({ input }) => askData(input.question)),
});
