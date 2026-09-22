// /app/src/lib/rateLimit.ts
//
// In-memory sliding window rate limiter for API routes. No external
// dependencies (Redis, etc.) -- appropriate for single-instance deployment
// on the Synology NAS.

import type { NextApiRequest, NextApiResponse } from "next";

interface RateLimitEntry {
  timestamps: number[];
}

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const store = new Map<string, RateLimitEntry>();

// Prune expired entries every 5 minutes to prevent memory growth
const PRUNE_INTERVAL = 5 * 60 * 1000;
let lastPrune = Date.now();

function pruneExpired(windowMs: number): void {
  const now = Date.now();
  if (now - lastPrune < PRUNE_INTERVAL) return;
  lastPrune = now;

  const cutoff = now - windowMs;
  for (const [key, entry] of store) {
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
    if (entry.timestamps.length === 0) store.delete(key);
  }
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
function getClientKey(req: NextApiRequest): string {
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
 * should be throttled, not every session read). Returns true when ALLOWED;
 * on the limit it writes the 429 + Retry-After and returns false, so the
 * caller just does `if (!checkRateLimit(...)) return;`. `bucket` namespaces
 * the counter so unrelated callers on the same IP don't share a window.
 */
export function checkRateLimit(
  req: NextApiRequest,
  res: NextApiResponse,
  config: RateLimitConfig,
  bucket = "default",
): boolean {
  const now = Date.now();
  const key = `${bucket}:${getClientKey(req)}`;
  const cutoff = now - config.windowMs;

  pruneExpired(config.windowMs);

  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }
  entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

  if (entry.timestamps.length >= config.maxRequests) {
    const retryAfter = Math.ceil((entry.timestamps[0] + config.windowMs - now) / 1000);
    res.setHeader("Retry-After", retryAfter.toString());
    res.setHeader("X-RateLimit-Limit", config.maxRequests.toString());
    res.setHeader("X-RateLimit-Remaining", "0");
    res.status(429).json({ error: "Too many requests", code: "RATE_LIMIT_EXCEEDED", retryAfter });
    return false;
  }

  entry.timestamps.push(now);
  res.setHeader("X-RateLimit-Limit", config.maxRequests.toString());
  res.setHeader("X-RateLimit-Remaining", (config.maxRequests - entry.timestamps.length).toString());
  return true;
}

// Returns a handler wrapper that enforces rate limits per client IP.
// Usage: export default rateLimit({ windowMs: 60000, maxRequests: 10 })(handler)
export function rateLimit(config: RateLimitConfig) {
  return function wrap(
    handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void | NextApiResponse>,
  ) {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      if (!checkRateLimit(req, res, config)) return;
      return handler(req, res);
    };
  };
}
