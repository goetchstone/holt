// /app/src/lib/booking/serviceRequestBody.ts
//
// Pure request-body validation for the scheduling admin endpoints -- services,
// availability windows, and calendar blocks (CLAUDE.md rule 14). Throws Error
// with a user-facing message; handlers surface it via getErrorMessage.

import { z } from "zod";
import { isValidHHMM, hhmmToMinutes } from "./scheduling";

const MAX_MINUTES = 24 * 60;

function first(error: z.ZodError, fallback: string): string {
  return error.issues[0]?.message ?? fallback;
}

const isoDate = z
  .string()
  .trim()
  .min(1, "Date is required")
  .transform((value, ctx) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
      return z.NEVER;
    }
    return date;
  });

// ---- Service ----
export const serviceCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  description: z.string().trim().max(2000).nullish(),
  durationMinutes: z
    .number()
    .int()
    .positive("Duration must be greater than zero")
    .max(MAX_MINUTES, "Duration can't exceed 24 hours"),
  bufferMinutes: z.number().int().min(0).max(240).optional(),
  price: z.number().nonnegative("Price can't be negative").nullish(),
  isPublic: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export type ServiceCreateInput = z.infer<typeof serviceCreateSchema>;
export function parseServiceCreateInput(body: unknown): ServiceCreateInput {
  const result = serviceCreateSchema.safeParse(body);
  if (!result.success) throw new Error(first(result.error, "Invalid service"));
  return result.data;
}

export const serviceUpdateSchema = serviceCreateSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: "Nothing to update" });
export type ServiceUpdateInput = z.infer<typeof serviceUpdateSchema>;
export function parseServiceUpdateInput(body: unknown): ServiceUpdateInput {
  const result = serviceUpdateSchema.safeParse(body);
  if (!result.success) throw new Error(first(result.error, "Invalid update"));
  return result.data;
}

// ---- Availability window ----
export const windowCreateSchema = z
  .object({
    dayOfWeek: z.number().int().min(0).max(6),
    startTime: z.string().refine(isValidHHMM, "Use HH:MM"),
    endTime: z.string().refine(isValidHHMM, "Use HH:MM"),
    serviceId: z.number().int().positive().nullable().optional(),
  })
  .refine((d) => hhmmToMinutes(d.endTime) > hhmmToMinutes(d.startTime), {
    message: "End time must be after the start time",
    path: ["endTime"],
  });
export type WindowCreateInput = z.infer<typeof windowCreateSchema>;
export function parseWindowCreateInput(body: unknown): WindowCreateInput {
  const result = windowCreateSchema.safeParse(body);
  if (!result.success) throw new Error(first(result.error, "Invalid availability window"));
  return result.data;
}

// ---- Calendar block (time off) ----
export const blockCreateSchema = z
  .object({
    startsAt: isoDate,
    endsAt: isoDate,
    reason: z.string().trim().max(200).nullish(),
    staffMemberId: z.number().int().positive().nullable().optional(),
  })
  .refine((d) => d.endsAt.getTime() > d.startsAt.getTime(), {
    message: "End must be after the start",
    path: ["endsAt"],
  });
export type BlockCreateInput = z.infer<typeof blockCreateSchema>;
export function parseBlockCreateInput(body: unknown): BlockCreateInput {
  const result = blockCreateSchema.safeParse(body);
  if (!result.success) throw new Error(first(result.error, "Invalid time off"));
  return result.data;
}
