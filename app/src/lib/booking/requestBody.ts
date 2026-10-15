// /app/src/lib/booking/requestBody.ts
//
// Pure request-body validation for the public booking-create API (CLAUDE.md
// rule 14: the coercion/validation lives here and is unit-tested; the handler
// stays thin). Throws Error with a user-facing message on invalid input so the
// handler can surface it via getErrorMessage and the client can toast it.

import { z } from "zod";

// Coerce an ISO date-time string into a Date, rejecting anything unparseable.
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

export const bookingInputSchema = z
  .object({
    customerName: z.string().trim().min(1, "Your name is required"),
    customerEmail: z.email("Enter a valid email"),
    customerPhone: z.string().trim().nullish(),
    serviceType: z.string().trim().nullish(),
    serviceId: z.number().int().positive().nullish(),
    startsAt: isoDate,
    endsAt: isoDate,
    notes: z.string().trim().nullish(),
  })
  // Zod still runs this refine when a date is empty (an empty string fails
  // .min(1) and never reaches the Date transform), and calling .getTime() on
  // that string threw a TypeError the handler returned to the visitor as
  // "data.startsAt.getTime is not a function"
  // (__tests__/fuzz/booking.fuzz.test.ts). Compare only two real dates; a
  // date that failed has already reported its own issue.
  .refine(
    ({ startsAt, endsAt }) =>
      !(startsAt instanceof Date && endsAt instanceof Date) ||
      endsAt.getTime() > startsAt.getTime(),
    {
      message: "End time must be after the start time",
      path: ["endsAt"],
    },
  );

export type BookingInput = z.infer<typeof bookingInputSchema>;

export function parseBookingInput(body: unknown): BookingInput {
  const result = bookingInputSchema.safeParse(body);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Invalid booking");
  }
  return result.data;
}
