// /app/src/lib/toastError.ts
//
// Pull a human-readable error message out of an axios/fetch error shape.
// Surfaces the backend's `{ error: "..." }` body when present so users see
// the real reason (e.g. "reason must be one of: ...") instead of a generic
// fallback. If no server message can be found, returns the fallback.
//
// Added in response to GitHub #111, where a validation mismatch produced
// HTTP 400 with a specific error message, but the UI swallowed it and
// showed only "Failed to archive quote". Use this helper in any client
// catch block that hits an API endpoint.

import axios from "axios";

export function getErrorMessage(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as unknown;
    if (data && typeof data === "object") {
      const maybe =
        (data as { error?: unknown; message?: unknown }).error ??
        (data as { message?: unknown }).message;
      if (typeof maybe === "string" && maybe.trim()) return maybe;
    }
    if (typeof err.message === "string" && err.message.trim() && err.message !== "Network Error") {
      return err.message;
    }
  }
  if (err instanceof Error && err.message.trim()) return err.message;
  return fallback;
}
