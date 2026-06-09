// /app/src/lib/loginActivity.ts
//
// Pure helpers for the login-activity admin view.
//
// Two responsibilities:
//
//   1. LAST_SEEN_THROTTLE_MS — shared constant the NextAuth jwt callback
//      uses to throttle DB writes for the lastSeenAt bump. Lives here so
//      the auth route + the helper tests share one source of truth.
//
//   2. Pure formatters/predicates the admin page uses to decide whether
//      a user is "active now" and to render relative timestamps without
//      pulling date-fns into a tiny render path.

/**
 * Shared shapes for the /admin/login-activity page + its API. Defined
 * here (not in the API file) so the page can import without pulling
 * the route handler into client bundles.
 */
export interface LoginActivityRow {
  id: number;
  displayName: string;
  email: string | null;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  lastSeenAt: string | null;
}

export interface LoginActivityResponse {
  staff: LoginActivityRow[];
  generatedAt: string;
}

/**
 * Don't write `StaffMember.lastSeenAt` more than once per minute per user.
 * Every authenticated request decodes the JWT and lands in the jwt
 * callback; without throttling we'd write thousands of rows per page-load.
 */
export const LAST_SEEN_THROTTLE_MS = 60_000;

/**
 * "Active now" = lastSeenAt within the active window. Default 5 minutes —
 * enough to cover a normal page-to-page click cadence without flickering
 * green/grey for users actively working.
 */
export const ACTIVE_NOW_WINDOW_MS = 5 * 60 * 1000;

/**
 * Returns true when the user was seen within `windowMs` of `now`.
 * Pure: takes Date | null (or a string) so it composes with API JSON.
 */
export function isActiveNow(
  lastSeenAt: Date | string | null | undefined,
  now: number = Date.now(),
  windowMs: number = ACTIVE_NOW_WINDOW_MS,
): boolean {
  if (!lastSeenAt) return false;
  const t = typeof lastSeenAt === "string" ? Date.parse(lastSeenAt) : lastSeenAt.getTime();
  if (!Number.isFinite(t)) return false;
  return now - t <= windowMs;
}

/**
 * Compact relative-time formatter for the activity table:
 * "just now" / "5m ago" / "2h ago" / "3d ago" / "Apr 14".
 *
 * Implemented inline rather than via date-fns because the admin table
 * renders dozens of these on every refresh; keeping the helper tiny and
 * pure also makes it trivial to test.
 */
export function formatLastSeen(
  value: Date | string | null | undefined,
  now: number = Date.now(),
): string {
  if (!value) return "never";
  const t = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (!Number.isFinite(t)) return "never";
  const diffMs = now - t;
  if (diffMs < 60_000) return "just now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMs / 3_600_000);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffMs / 86_400_000);
  if (diffDay < 7) return `${diffDay}d ago`;
  const d = new Date(t);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
