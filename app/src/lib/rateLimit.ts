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
// alone collapses all external clients into one shared bucket. nginx sets
// X-Real-IP to the real peer server-side on every request; unlike
// X-Forwarded-For it is overwritten (not appended) by the proxy, so a client
// hitting nginx cannot forge it. We therefore trust X-Real-IP when present.
//
// X-Forwarded-For stays attacker-controlled (anyone hitting the app directly
// can spoof it), so it is only consulted for multi-hop topologies that set
// TRUST_PROXY=true and don't provide X-Real-IP; there we take the LAST hop —
// the IP the proxy itself appended — not the spoofable left-most entry. With
// neither header we fall back to the raw socket peer.
function getClientKey(req: NextApiRequest): string {
  const socketIp = req.socket?.remoteAddress ?? "unknown";

  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.trim().length > 0) {
    return realIp.trim();
  }

  if (process.env.TRUST_PROXY !== "true") return socketIp;
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
