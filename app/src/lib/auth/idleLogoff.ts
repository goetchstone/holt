// /app/src/lib/auth/idleLogoff.ts
//
// GAP-27: a signed-in session ends after the store's idle time
// (AppSettings.idleLogoffMinutes). Pure and client-safe; the server half is
// lib/auth/sessionToken.ts, the screen half components/auth/IdleLogoff.tsx.
//
// Activity means a person at the screen: typing, tapping, the mouse. A
// background refresh (notifications, the Up Board, the home dashboard) is not
// activity, or a screen left open would keep itself signed in forever. So the
// browser reports activity (at most once a PING_MS) and the session token
// records it as `lastActiveAt`; nothing else moves it.
//
// Two clocks, one deadline:
//   - The browser signs out at lastInput + idle time, after a WARN_MS warning.
//   - The token expires at lastActiveAt + idle time + SERVER_GRACE_MS, so every
//     guard refuses it even when no browser is left to sign out (a closed
//     laptop, a killed tab). The grace exceeds PING_MS, so the server never
//     ends a session before the browser's warning has run out.

/** 0 = the store has turned automatic sign-out off. */
export const IDLE_LOGOFF_OFF = 0;
export const IDLE_LOGOFF_MIN_MINUTES = 5;
/** A full shift. */
export const IDLE_LOGOFF_MAX_MINUTES = 720;
/** The shipped default: the strict one. */
export const IDLE_LOGOFF_DEFAULT_MINUTES = 15;

/** How long the "Still there?" warning shows before sign-out. */
export const WARN_MS = 60_000;
/** The most often a browser reports activity to the server. */
export const PING_MS = 60_000;
/** How long the server outlives the browser's deadline. Must exceed PING_MS. */
export const SERVER_GRACE_MS = 2 * 60_000;

export const IDLE_LOGOFF_RULE = `0 (off) or a whole number of minutes from ${IDLE_LOGOFF_MIN_MINUTES} to ${IDLE_LOGOFF_MAX_MINUTES}`;

export function isIdleLogoffMinutes(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value === IDLE_LOGOFF_OFF ||
      (value >= IDLE_LOGOFF_MIN_MINUTES && value <= IDLE_LOGOFF_MAX_MINUTES))
  );
}

/** The store's idle time as the session carries it; anything else is the strict default. */
export function sessionIdleMinutes(session: unknown): number {
  const raw =
    session && typeof session === "object"
      ? (session as { idleLogoffMinutes?: unknown }).idleLogoffMinutes
      : undefined;
  return isIdleLogoffMinutes(raw) ? raw : IDLE_LOGOFF_DEFAULT_MINUTES;
}

/**
 * Seconds the session token is good for, counted from now: what is left of the
 * idle time since `lastActiveAt` (plus the grace), never more than `ceilingSeconds`
 * (the session's own lifetime). Negative once it has run out, so a token
 * re-issued then is born expired -- not at zero, which every reader would still
 * accept for its 15 seconds of clock tolerance. With automatic sign-out off,
 * the ceiling.
 */
export function sessionMaxAgeSeconds(args: {
  lastActiveAt: number;
  now: number;
  idleMinutes: number;
  ceilingSeconds: number;
}): number {
  if (args.idleMinutes === IDLE_LOGOFF_OFF) return args.ceilingSeconds;
  const endsAt = args.lastActiveAt + args.idleMinutes * 60_000 + SERVER_GRACE_MS;
  const left = Math.floor((endsAt - args.now) / 1000);
  return Math.min(args.ceilingSeconds, left);
}

export type IdlePhase =
  { phase: "active" } | { phase: "warning"; msLeft: number } | { phase: "expired" };

/** Where a screen stands, given when someone last used it. */
export function idlePhase(args: {
  now: number;
  lastInput: number;
  idleMinutes: number;
}): IdlePhase {
  if (args.idleMinutes === IDLE_LOGOFF_OFF) return { phase: "active" };
  const msLeft = args.lastInput + args.idleMinutes * 60_000 - args.now;
  if (msLeft <= 0) return { phase: "expired" };
  if (msLeft <= WARN_MS) return { phase: "warning", msLeft };
  return { phase: "active" };
}

/** Is it time to tell the server about activity since the last report? */
export function pingDue(args: { now: number; lastInput: number; lastPing: number }): boolean {
  return args.lastInput > args.lastPing && args.now - args.lastPing >= PING_MS;
}

/** "0:42" */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
