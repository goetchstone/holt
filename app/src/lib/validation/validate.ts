// /app/src/lib/validation/validate.ts
//
// Thin wrapper around Zod for API request validation.
// Throws ValidationError (caught by apiHandler) on failure.

import type { ZodType, ZodError } from "zod";
import { ValidationError } from "@/lib/apiHandler";

/**
 * Validate a request body against a Zod schema.
 * Returns the parsed (and typed) data on success.
 * Throws ValidationError with field-level details on failure.
 */
export function validateBody<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);

  if (result.success) {
    return result.data;
  }

  const details = formatZodError(result.error);
  throw new ValidationError("Validation failed", details);
}

function formatZodError(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "_root";
    if (!details[path]) {
      details[path] = [];
    }
    details[path].push(issue.message);
  }

  return details;
}
