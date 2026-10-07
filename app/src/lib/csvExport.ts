// /app/src/lib/csvExport.ts
//
// Shared helpers for the CSV-export endpoints under
// `pages/api/reports/.../export.ts`. The pattern is:
//
//   1. Capture an in-process Next.js handler's JSON response without
//      doing an HTTP round-trip (saves a network hop and keeps the
//      role gate + filter parsing in one place — the inner handler).
//   2. RFC 4180-ish escape values into CSV cells.
//
// Currently used by:
//   - sales-by-salesperson/export.ts
//   - detailed-sales/export.ts
//
// Extracted 2026-04-30 because Sonar new_duplicated_lines_density was
// going RED on the second usage. Two callers is enough to share — but
// keep the helpers small and obvious; resist piling more knobs on.

import type { NextApiRequest, NextApiResponse } from "next";

/**
 * RFC 4180-ish CSV escaping: wrap in quotes if the value contains
 * commas, quotes, or newlines; double any embedded quotes.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

/** Join cells into a CSV row terminated with a newline. */
export function csvRow(cells: (string | number | null | undefined)[]): string {
  return cells.map(csvCell).join(",") + "\n";
}

/**
 * Capture an inner handler's response into an in-memory object so an
 * outer endpoint can shape the bytes (e.g. into CSV) without an HTTP
 * round-trip. The fake `res` object captures the JSON body; if the
 * inner handler returns non-2xx, the captured error message is
 * rethrown so the caller's try/catch surfaces it.
 *
 * Inner handlers typically return `Promise<void | NextApiResponse>`
 * because their bodies say `return res.status(...).json(...)`. The
 * `Promise<unknown>` here lets either shape pass without forcing every
 * inner file to widen its annotation.
 */
export async function callHandlerJson<T>(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>,
  req: NextApiRequest,
): Promise<T> {
  let captured: T | null = null;
  let statusCode = 200;
  let errorMessage: string | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeRes: any = {
    status(code: number) {
      statusCode = code;
      return fakeRes;
    },
    setHeader() {
      return fakeRes;
    },
    json(body: unknown) {
      if (statusCode >= 200 && statusCode < 300) {
        captured = body as T;
      } else if (body && typeof body === "object" && "error" in body) {
        errorMessage = String((body as { error: unknown }).error);
      }
      return fakeRes;
    },
    end() {
      return fakeRes;
    },
  };

  await handler(req, fakeRes);
  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(errorMessage ?? `Inner handler failed with ${statusCode}`);
  }
  if (captured === null) {
    throw new Error("Inner handler did not produce JSON");
  }
  return captured;
}
