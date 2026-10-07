// /app/__tests__/loginActivity.test.ts
//
// A-grade pure-helper tests for the login-activity helpers + B-grade
// source-text tripwires for the NextAuth wiring.

import { readFileSync } from "fs";
import { join } from "path";
import {
  isActiveNow,
  formatLastSeen,
  ACTIVE_NOW_WINDOW_MS,
  LAST_SEEN_THROTTLE_MS,
} from "@/lib/loginActivity";

describe("isActiveNow", () => {
  const NOW = new Date("2026-04-30T16:00:00Z").getTime();

  it("returns false for null/undefined", () => {
    expect(isActiveNow(null, NOW)).toBe(false);
    expect(isActiveNow(undefined, NOW)).toBe(false);
  });

  it("returns false for unparseable strings", () => {
    expect(isActiveNow("not a date", NOW)).toBe(false);
  });

  it("returns true within the active window (default 5 min)", () => {
    expect(isActiveNow(new Date(NOW - 60_000), NOW)).toBe(true); // 1 min ago
    expect(isActiveNow(new Date(NOW - 4 * 60_000), NOW)).toBe(true); // 4 min ago
  });

  it("returns false outside the active window", () => {
    expect(isActiveNow(new Date(NOW - 6 * 60_000), NOW)).toBe(false); // 6 min ago
    expect(isActiveNow(new Date(NOW - 60 * 60_000), NOW)).toBe(false); // 1 hr ago
  });

  it("accepts ISO strings (the API JSON shape)", () => {
    const iso = new Date(NOW - 60_000).toISOString();
    expect(isActiveNow(iso, NOW)).toBe(true);
  });

  it("respects custom window override", () => {
    const tenMinAgo = new Date(NOW - 10 * 60_000);
    expect(isActiveNow(tenMinAgo, NOW)).toBe(false); // outside default 5 min
    expect(isActiveNow(tenMinAgo, NOW, 15 * 60_000)).toBe(true); // inside custom 15 min
  });
});

describe("formatLastSeen", () => {
  const NOW = new Date("2026-04-30T16:00:00Z").getTime();

  it("returns 'never' for null/undefined", () => {
    expect(formatLastSeen(null, NOW)).toBe("never");
    expect(formatLastSeen(undefined, NOW)).toBe("never");
  });

  it("returns 'never' for unparseable strings", () => {
    expect(formatLastSeen("garbage", NOW)).toBe("never");
  });

  it("returns 'just now' under 60 seconds", () => {
    expect(formatLastSeen(new Date(NOW - 30_000), NOW)).toBe("just now");
    expect(formatLastSeen(new Date(NOW - 1_000), NOW)).toBe("just now");
  });

  it("returns minutes for 1m–59m", () => {
    expect(formatLastSeen(new Date(NOW - 60_000), NOW)).toBe("1m ago");
    expect(formatLastSeen(new Date(NOW - 5 * 60_000), NOW)).toBe("5m ago");
    expect(formatLastSeen(new Date(NOW - 59 * 60_000), NOW)).toBe("59m ago");
  });

  it("returns hours for 1h–23h", () => {
    expect(formatLastSeen(new Date(NOW - 60 * 60_000), NOW)).toBe("1h ago");
    expect(formatLastSeen(new Date(NOW - 23 * 60 * 60_000), NOW)).toBe("23h ago");
  });

  it("returns days for 1d–6d", () => {
    expect(formatLastSeen(new Date(NOW - 24 * 60 * 60_000), NOW)).toBe("1d ago");
    expect(formatLastSeen(new Date(NOW - 6 * 24 * 60 * 60_000), NOW)).toBe("6d ago");
  });

  it("returns absolute date (Mon Day) at 7+ days", () => {
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60_000);
    const formatted = formatLastSeen(tenDaysAgo, NOW);
    // Locale-aware so the assertion just checks the shape.
    expect(formatted).toMatch(/^[A-Z][a-z]{2,3} \d{1,2}$/);
  });

  it("accepts ISO strings", () => {
    const iso = new Date(NOW - 5 * 60_000).toISOString();
    expect(formatLastSeen(iso, NOW)).toBe("5m ago");
  });
});

describe("constants", () => {
  it("LAST_SEEN_THROTTLE_MS is 60 seconds (matches the auth callback's contract)", () => {
    expect(LAST_SEEN_THROTTLE_MS).toBe(60_000);
  });

  it("ACTIVE_NOW_WINDOW_MS is 5 minutes (the table's status pill)", () => {
    expect(ACTIVE_NOW_WINDOW_MS).toBe(5 * 60_000);
  });
});

describe("NextAuth wiring (source-text tripwire)", () => {
  // Strip line comments so docstrings discussing the wiring don't trip
  // assertions.
  const raw = readFileSync(
    join(__dirname, "..", "src", "pages", "api", "auth", "[...nextauth].ts"),
    "utf8",
  );
  const code = raw
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join("\n");

  it("imports LAST_SEEN_THROTTLE_MS from the shared lib", () => {
    expect(code).toMatch(/LAST_SEEN_THROTTLE_MS.*from\s+["']@\/lib\/loginActivity["']/);
  });

  it("stamps lastLoginAt + lastSeenAt on fresh sign-in", () => {
    expect(code).toMatch(/lastLoginAt:\s*new Date\(\)/);
    expect(code).toMatch(/lastSeenAt:\s*new Date\(\)/);
  });

  it("throttles lastSeenAt updates against the JWT-side timestamp", () => {
    expect(code).toMatch(/lastSeenBumpedAt/);
    expect(code).toMatch(/now - lastBump > LAST_SEEN_THROTTLE_MS/);
  });

  it("uses updateMany so users without a StaffMember row don't 500", () => {
    expect(code).toMatch(/staffMember\.updateMany/);
  });
});

describe("schema migration tripwire", () => {
  // The historical per-feature migrations were squashed into a single
  // 0_init baseline, so this tripwire now asserts the login-activity
  // columns are present in that baseline (same intent: the shipped schema
  // creates these columns on the StaffMember table).
  const sql = readFileSync(
    join(__dirname, "..", "prisma", "migrations", "0_init", "migration.sql"),
    "utf8",
  );

  it("defines lastLoginAt column", () => {
    expect(sql).toMatch(/"lastLoginAt"\s+TIMESTAMP/i);
  });

  it("defines lastSeenAt column", () => {
    expect(sql).toMatch(/"lastSeenAt"\s+TIMESTAMP/i);
  });

  it("creates the StaffMember table", () => {
    expect(sql).toMatch(/CREATE TABLE\s+"StaffMember"/);
  });
});
