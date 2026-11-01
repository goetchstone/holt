// /app/__tests__/lib/auth/idleLogoff.test.ts
//
// GAP-27's timing rules (lib/auth/idleLogoff.ts): what the store may set, when a
// screen warns and signs out, when the browser reports activity, and how long
// the server keeps a session -- including that the server never ends one before
// the browser's warning has run out.

import {
  IDLE_LOGOFF_DEFAULT_MINUTES,
  PING_MS,
  SERVER_GRACE_MS,
  WARN_MS,
  formatCountdown,
  idlePhase,
  isIdleLogoffMinutes,
  pingDue,
  sessionIdleMinutes,
  sessionMaxAgeSeconds,
} from "@/lib/auth/idleLogoff";

const MINUTE = 60_000;
const NOW = Date.UTC(2026, 9, 31, 15, 0, 0);
const CEILING = 30 * 24 * 60 * 60;

describe("what a store may set", () => {
  it("is 0 for off, or a whole number of minutes from 5 to 720", () => {
    for (const ok of [0, 5, 15, 720]) expect(isIdleLogoffMinutes(ok)).toBe(true);
    for (const bad of [-1, 1, 4, 721, 12.5, Number.NaN, "15", null, undefined]) {
      expect(isIdleLogoffMinutes(bad)).toBe(false);
    }
  });

  it("is the strict 15 minutes when the session carries nothing usable", () => {
    expect(IDLE_LOGOFF_DEFAULT_MINUTES).toBe(15);
    expect(sessionIdleMinutes({ idleLogoffMinutes: 30 })).toBe(30);
    expect(sessionIdleMinutes({ idleLogoffMinutes: 0 })).toBe(0);
    for (const s of [null, undefined, {}, { idleLogoffMinutes: 3 }, { idleLogoffMinutes: "0" }]) {
      expect(sessionIdleMinutes(s)).toBe(15);
    }
  });
});

describe("a screen", () => {
  const at = (idleFor: number, idleMinutes = 15) =>
    idlePhase({ now: NOW, lastInput: NOW - idleFor, idleMinutes });

  it("is active until the last minute, warns through it, then signs out", () => {
    expect(at(13 * MINUTE)).toEqual({ phase: "active" });
    expect(at(14 * MINUTE)).toEqual({ phase: "warning", msLeft: WARN_MS });
    expect(at(14.5 * MINUTE)).toEqual({ phase: "warning", msLeft: 30_000 });
    expect(at(15 * MINUTE)).toEqual({ phase: "expired" });
    expect(at(3 * 60 * MINUTE)).toEqual({ phase: "expired" });
  });

  it("follows the store's time, and never signs out when it is off", () => {
    expect(at(20 * MINUTE, 30)).toEqual({ phase: "active" });
    expect(at(30 * 24 * 60 * MINUTE, 0)).toEqual({ phase: "active" });
  });

  it("counts down in minutes and seconds", () => {
    expect(formatCountdown(60_000)).toBe("1:00");
    expect(formatCountdown(42_001)).toBe("0:43");
    expect(formatCountdown(500)).toBe("0:01");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("reporting activity", () => {
  it("goes at most once a minute, and only for activity since the last report", () => {
    expect(pingDue({ now: NOW, lastInput: NOW, lastPing: 0 })).toBe(true);
    expect(pingDue({ now: NOW, lastInput: NOW, lastPing: NOW - PING_MS + 1 })).toBe(false);
    expect(pingDue({ now: NOW, lastInput: NOW, lastPing: NOW - PING_MS })).toBe(true);
    expect(pingDue({ now: NOW, lastInput: NOW - 2 * PING_MS, lastPing: NOW - PING_MS })).toBe(
      false,
    );
  });
});

describe("the server's expiry", () => {
  it("is the time left since the last activity, plus the grace", () => {
    const seconds = sessionMaxAgeSeconds({
      lastActiveAt: NOW - 10 * MINUTE,
      now: NOW,
      idleMinutes: 15,
      ceilingSeconds: CEILING,
    });
    expect(seconds).toBe((5 * MINUTE + SERVER_GRACE_MS) / 1000);
  });

  it("is in the past once that has run out, so a re-issued token is born expired", () => {
    const seconds = sessionMaxAgeSeconds({
      lastActiveAt: NOW - 60 * MINUTE,
      now: NOW,
      idleMinutes: 15,
      ceilingSeconds: CEILING,
    });
    // Past the 15 seconds of clock tolerance every reader allows.
    expect(seconds).toBeLessThan(-15);
  });

  it("is the session's ceiling when the store has turned it off, and never beyond it", () => {
    const off = { lastActiveAt: NOW - CEILING * 2000, now: NOW, idleMinutes: 0 };
    expect(sessionMaxAgeSeconds({ ...off, ceilingSeconds: CEILING })).toBe(CEILING);
    const short = { lastActiveAt: NOW, now: NOW, idleMinutes: 720, ceilingSeconds: 60 };
    expect(sessionMaxAgeSeconds(short)).toBe(60);
  });

  it("never comes before the browser's own sign-out", () => {
    // The browser reports at most once a PING_MS, so the server's lastActiveAt
    // can trail the last real activity by up to that much.
    expect(SERVER_GRACE_MS).toBeGreaterThan(PING_MS);
    for (const idleMinutes of [5, 15, 720]) {
      for (const lag of [0, 1, PING_MS / 2, PING_MS]) {
        const lastInput = NOW;
        const lastActiveAt = lastInput - lag;
        const browserSignsOut = lastInput + idleMinutes * MINUTE;
        const serverEnds =
          NOW +
          sessionMaxAgeSeconds({ lastActiveAt, now: NOW, idleMinutes, ceilingSeconds: CEILING }) *
            1000;
        expect(serverEnds).toBeGreaterThan(browserSignsOut);
      }
    }
  });
});
