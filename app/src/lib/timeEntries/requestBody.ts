// /app/src/lib/timeEntries/requestBody.ts
//
// Pure request-body validation for the time-entry endpoints (CLAUDE.md rule 14).
// The client parses the duration shorthand to integer minutes (lib/duration.ts)
// before posting; the server validates the resulting minutes.

import { z } from "zod";

const MAX_MINUTES = 24 * 60;

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

export const timeEntryCreateSchema = z.object({
  description: z.string().trim().min(1, "A description is required").max(500),
  minutes: z
    .number()
    .int()
    .positive("Duration must be greater than zero")
    .max(MAX_MINUTES, "Duration can't exceed 24 hours"),
  date: isoDate,
  isBillable: z.boolean().optional(),
  customerId: z.number().int().positive().nullable().optional(),
  // ADMIN/MANAGER may log time for another staff member; otherwise the handler
  // forces the logger's own id.
  staffMemberId: z.number().int().positive().optional(),
});
export type TimeEntryCreateInput = z.infer<typeof timeEntryCreateSchema>;
export function parseTimeEntryCreateInput(body: unknown): TimeEntryCreateInput {
  const result = timeEntryCreateSchema.safeParse(body);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Invalid time entry");
  }
  return result.data;
}

export const timeEntryUpdateSchema = z
  .object({
    description: z.string().trim().min(1, "Description cannot be empty").max(500).optional(),
    minutes: z.number().int().positive().max(MAX_MINUTES).optional(),
    date: isoDate.optional(),
    isBillable: z.boolean().optional(),
    customerId: z.number().int().positive().nullable().optional(),
    // Mark billed / un-billed -- maps to setting/clearing billedAt server-side.
    billed: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "Nothing to update" });
export type TimeEntryUpdateInput = z.infer<typeof timeEntryUpdateSchema>;
export function parseTimeEntryUpdateInput(body: unknown): TimeEntryUpdateInput {
  const result = timeEntryUpdateSchema.safeParse(body);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Invalid update");
  }
  return result.data;
}
