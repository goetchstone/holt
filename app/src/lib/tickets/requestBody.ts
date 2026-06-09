// /app/src/lib/tickets/requestBody.ts
//
// Pure request-body validation for the helpdesk endpoints (CLAUDE.md rule 14:
// coercion/validation lives here, unit-tested; handlers stay thin). Each parser
// throws an Error with a user-facing message so the handler can surface it via
// getErrorMessage.

import { z } from "zod";
import { TICKET_STATUS_VALUES, TICKET_PRIORITY_VALUES } from "./ticketContract";

function firstError(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

// Public submit (no auth) -- an anonymous visitor opening a ticket.
export const ticketCreateSchema = z.object({
  submitterName: z.string().trim().min(1, "Your name is required").max(120),
  submitterEmail: z.email("Enter a valid email"),
  subject: z.string().trim().min(1, "A subject is required").max(200),
  body: z.string().trim().min(1, "Please describe how we can help").max(5000),
  priority: z.enum(TICKET_PRIORITY_VALUES).optional(),
});
export type TicketCreateInput = z.infer<typeof ticketCreateSchema>;
export function parseTicketCreateInput(body: unknown): TicketCreateInput {
  const result = ticketCreateSchema.safeParse(body);
  if (!result.success) throw new Error(firstError(result.error, "Invalid ticket"));
  return result.data;
}

// Staff update -- any subset of the triage fields. assignedToId null = unassign.
export const ticketUpdateSchema = z
  .object({
    status: z.enum(TICKET_STATUS_VALUES).optional(),
    priority: z.enum(TICKET_PRIORITY_VALUES).optional(),
    assignedToId: z.number().int().positive().nullable().optional(),
    subject: z.string().trim().min(1, "Subject cannot be empty").max(200).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "Nothing to update" });
export type TicketUpdateInput = z.infer<typeof ticketUpdateSchema>;
export function parseTicketUpdateInput(body: unknown): TicketUpdateInput {
  const result = ticketUpdateSchema.safeParse(body);
  if (!result.success) throw new Error(firstError(result.error, "Invalid update"));
  return result.data;
}

// A message on a ticket. isInternal is staff-only -- the public reply path
// forces it false in the handler.
export const ticketMessageSchema = z.object({
  body: z.string().trim().min(1, "Message cannot be empty").max(5000),
  isInternal: z.boolean().optional(),
});
export type TicketMessageInput = z.infer<typeof ticketMessageSchema>;
export function parseTicketMessageInput(body: unknown): TicketMessageInput {
  const result = ticketMessageSchema.safeParse(body);
  if (!result.success) throw new Error(firstError(result.error, "Invalid message"));
  return result.data;
}
