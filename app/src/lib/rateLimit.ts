// /app/src/lib/rateLimit.ts
//
// Rate limiter for API routes, kept in Postgres so the limit holds across every
// app process.
//
// It used to count in a Map in each process's memory. With several processes
// behind nginx (docs/HOSTING.md) each one allowed its own full allowance, so
// three processes let a client make three times the login attempts, password
// resets and card payments the limit says. The count now lives in
// RateLimitWindow, one row per (bucket, client, window), and each request adds
// to it with one atomic INSERT ... ON CONFLICT DO UPDATE ... RETURNING. Two
// processes counting the same client at the same moment both land in that one
// row, and Postgres orders them.
//
// A fixed window, not a sliding one: a client gets maxRequests per window, and
// the count starts again when the next window does. That allows up to twice the
// limit across a window boundary, which every limit here tolerates (they blunt
// guessing and spam, they do not meter).
//
// Expired rows are deleted here, at most once every PRUNE_INTERVAL_MS per
// process, by one indexed DELETE. Nothing else has to run for the table to stay
// small.

import type { NextApiRequest, NextApiResponse } from "next";

import { prisma } from "@/lib/prisma";
import { logError } from "@/lib/logger";

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
let lastPrune = 0;

/** The start of the fixed window `now` falls in. Pure. */
export function windowStartFor(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs;
}

/** Seconds until the window starting at `windowStart` ends, never below 1. Pure. */
export function retryAfterSeconds(now: number, windowStart: number, windowMs: number): number {
  return Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
}

async function pruneExpired(now: number): Promise<void> {
  if (now - lastPrune < PRUNE_INTERVAL_MS) return;
  lastPrune = now;
  try {
    await prisma.rateLimitWindow.deleteMany({ where: { expiresAt: { lt: new Date(now) } } });
  } catch (err) {
    // A failed prune only leaves dead rows for the next one.
    logError("Rate limit prune failed", err);
  }
}

/** Count one request and return the window's count including it. */
async function countRequest(
  bucket: string,
  clientKey: string,
  windowStart: number,
  windowMs: number,
): Promise<number> {
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimitWindow" ("bucket", "clientKey", "windowStart", "count", "expiresAt")
    VALUES (${bucket}, ${clientKey}, ${new Date(windowStart)}, 1, ${new Date(windowStart + windowMs)})
    ON CONFLICT ("bucket", "clientKey", "windowStart")
    DO UPDATE SET "count" = "RateLimitWindow"."count" + 1
    RETURNING "count"`;
  return Number(rows[0].count);
}

// Resolve the client IP for rate limiting. Behind the bundled nginx, every
// request's socket peer is nginx's own container IP, so keying on the socket
// alone collapses all external clients into one shared bucket. A trusted proxy
// fixes that: it sets X-Real-IP to the real peer server-side (overwritten, not
// appended) and appends that peer to X-Forwarded-For. Both are reliable ONLY
// when we know such a proxy sits in front of us -- which is exactly what
// TRUST_PROXY=true asserts.
//
// When TRUST_PROXY is unset the Node port is reachable directly and a client
// can put any value in EITHER header. X-Real-IP is no safer than
// X-Forwarded-For here: trusting it let anyone rotate one header to mint a
// fresh bucket per request and slip every limit, including the credentials
// throttle. So with no trusted proxy we key on the raw socket peer and ignore
// both headers. With one, we prefer X-Real-IP and otherwise take the LAST
// X-Forwarded-For hop -- the IP the proxy itself appended -- never the
// spoofable left-most entry.
export function getClientKey(req: NextApiRequest): string {
  const socketIp = req.socket?.remoteAddress ?? "unknown";

  // No trusted proxy in front -> both headers are attacker-controlled -> key on
  // the socket peer alone.
  if (process.env.TRUST_PROXY !== "true") return socketIp;

  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim().length > 0) {
    return realIp.trim();
  }

  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || forwarded.trim().length === 0) return socketIp;
  const hops = forwarded
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : socketIp;
}

/**
 * One-shot rate-limit check usable inside a handler that can't be wrapped
 * (e.g. the NextAuth catch-all, where only the credentials-callback POST
 * should be throttled, not every session read). Resolves true when ALLOWED;
 * on the limit it writes the 429 + Retry-After and resolves false, so the
 * caller just does `if (!(await checkRateLimit(...))) return;`. `bucket`
 * names the route, so unrelated routes on the same IP don't share a window.
 *
 * Counted in the database, so the limit is the same however many app
 * processes serve the site. A request over the limit still counts, so a
 * client that keeps hammering stays limited until the window ends.
 */
export async function checkRateLimit(
  req: NextApiRequest,
  res: NextApiResponse,
  config: RateLimitConfig,
  bucket: string,
): Promise<boolean> {
  const now = Date.now();
  const windowStart = windowStartFor(now, config.windowMs);
  await pruneExpired(now);

  const count = await countRequest(bucket, getClientKey(req), windowStart, config.windowMs);

  res.setHeader("X-RateLimit-Limit", config.maxRequests.toString());
  if (count > config.maxRequests) {
    const retryAfter = retryAfterSeconds(now, windowStart, config.windowMs);
    res.setHeader("Retry-After", retryAfter.toString());
    res.setHeader("X-RateLimit-Remaining", "0");
    res.status(429).json({ error: "Too many requests", code: "RATE_LIMIT_EXCEEDED", retryAfter });
    return false;
  }
  res.setHeader("X-RateLimit-Remaining", (config.maxRequests - count).toString());
  return true;
}

/**
 * Returns a handler wrapper that enforces a rate limit per client IP. `bucket`
 * names the route: each route keeps its own count, so a client's lookups on
 * one public route do not use up its allowance on another.
 *
 * Usage: export default rateLimit({ windowMs: 60000, maxRequests: 10 }, "my-route")(handler)
 */
export function rateLimit(config: RateLimitConfig, bucket: string) {
  return function wrap(
    handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void | NextApiResponse>,
  ) {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      if (!(await checkRateLimit(req, res, config, bucket))) return;
      return handler(req, res);
    };
  };
}
