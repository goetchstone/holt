// /app/__tests__/rateLimit.test.ts
//
// The pure half of lib/rateLimit.ts: whose request it is (getClientKey), which
// window it falls in, and how long until it ends. The counting itself is in
// Postgres, so it is tested against a real database, across two module
// instances standing in for two app processes:
// __tests__/integration/rateLimit.integration.test.ts.
//
// And a tripwire over the call sites (rule 65): every rateLimit() wrapper names
// its own bucket. They all used to share "default", so a client's lookups on one
// public route spent its allowance on every other.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { NextApiRequest } from "next";

import { getClientKey, retryAfterSeconds, windowStartFor } from "@/lib/rateLimit";

function req(opts: { socketIp?: string; realIp?: string; forwardedFor?: string }): NextApiRequest {
  const headers: Record<string, string> = {};
  if (opts.realIp !== undefined) headers["x-real-ip"] = opts.realIp;
  if (opts.forwardedFor !== undefined) headers["x-forwarded-for"] = opts.forwardedFor;
  return {
    headers,
    socket: { remoteAddress: opts.socketIp ?? "10.9.9.9" },
  } as unknown as NextApiRequest;
}

describe("windowStartFor / retryAfterSeconds", () => {
  it("puts every moment of a window in the same window", () => {
    const minute = 60_000;
    const start = 1_700_000_040_000; // a whole minute
    expect(windowStartFor(start, minute)).toBe(start);
    expect(windowStartFor(start + 59_999, minute)).toBe(start);
    expect(windowStartFor(start + 60_000, minute)).toBe(start + minute);
  });

  it("counts the seconds left in the window, never less than one", () => {
    const start = 1_700_000_040_000;
    expect(retryAfterSeconds(start, start, 60_000)).toBe(60);
    expect(retryAfterSeconds(start + 59_500, start, 60_000)).toBe(1);
    expect(retryAfterSeconds(start + 60_000, start, 60_000)).toBe(1);
  });
});

describe("getClientKey", () => {
  let savedTrustProxy: string | undefined;
  beforeEach(() => {
    savedTrustProxy = process.env.TRUST_PROXY;
  });
  afterEach(() => {
    if (savedTrustProxy === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = savedTrustProxy;
  });

  it("keys on the socket peer and ignores both headers when no proxy is trusted", () => {
    // The Node port is reachable directly, so the headers are the client's to
    // set: rotating X-Real-IP must not mint a fresh count per request.
    delete process.env.TRUST_PROXY;
    expect(getClientKey(req({ socketIp: "198.51.100.7", realIp: "203.0.113.1" }))).toBe(
      "198.51.100.7",
    );
    expect(getClientKey(req({ socketIp: "198.51.100.7", forwardedFor: "203.0.113.2" }))).toBe(
      "198.51.100.7",
    );
  });

  it("behind a trusted proxy, prefers X-Real-IP", () => {
    process.env.TRUST_PROXY = "true";
    expect(
      getClientKey(req({ socketIp: "172.18.0.5", realIp: "203.0.113.9", forwardedFor: "1.1.1.1" })),
    ).toBe("203.0.113.9");
  });

  it("behind a trusted proxy with no X-Real-IP, takes the LAST X-Forwarded-For hop", () => {
    // The left-most entry is whatever the client sent; the last is the one the
    // proxy appended.
    process.env.TRUST_PROXY = "true";
    expect(getClientKey(req({ forwardedFor: "6.6.6.6, 203.0.113.4" }))).toBe("203.0.113.4");
    expect(getClientKey(req({ socketIp: "10.1.1.1" }))).toBe("10.1.1.1");
  });
});

describe("every rateLimit() call site names a bucket of its own", () => {
  const APP = join(__dirname, "..");

  function filesUnder(dir: string): string[] {
    return readdirSync(join(APP, dir)).flatMap((name) => {
      const path = `${dir}/${name}`;
      if (statSync(join(APP, path)).isDirectory()) return filesUnder(path);
      return /\.tsx?$/.test(name) ? [path] : [];
    });
  }

  /** Every call of rateLimit(...) or checkRateLimit(...) outside the module itself. */
  const sites = filesUnder("src")
    .filter((f) => f !== "src/lib/rateLimit.ts")
    .flatMap((file) => {
      const text = readFileSync(join(APP, file), "utf8");
      return [...text.matchAll(/\b(rateLimit|checkRateLimit)\(/g)].map((m) => {
        // The call's argument list, up to its matching closing parenthesis.
        const open = (m.index ?? 0) + m[0].length - 1;
        let depth = 0;
        let close = open;
        for (; close < text.length; close++) {
          if (text[close] === "(") depth++;
          else if (text[close] === ")" && --depth === 0) break;
        }
        const args = text.slice(open + 1, close).trim();
        const bucket = /["']([a-z][a-z0-9-]*)["'],?$/.exec(args)?.[1] ?? null;
        return { file, fn: m[1], bucket };
      });
    });

  it("finds the call sites (a scan that finds nothing proves nothing)", () => {
    expect(sites.filter((s) => s.fn === "rateLimit").length).toBeGreaterThanOrEqual(20);
    expect(sites.some((s) => s.fn === "checkRateLimit" && s.bucket === "login")).toBe(true);
  });

  it("names a bucket at every call", () => {
    expect(sites.filter((s) => s.bucket === null)).toEqual([]);
  });

  it("never reuses one route's bucket on another", () => {
    const byBucket = new Map<string, string[]>();
    for (const s of sites) {
      if (!s.bucket) continue;
      byBucket.set(s.bucket, [...(byBucket.get(s.bucket) ?? []), s.file]);
    }
    expect([...byBucket].filter(([, files]) => files.length > 1)).toEqual([]);
  });
});
