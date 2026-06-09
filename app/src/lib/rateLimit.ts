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

// Resolve the client IP for rate limiting. X-Forwarded-For is attacker-controlled
// (anyone hitting the app directly can spoof it), so we ignore it by default and
// key on the real socket peer. A deployment that sits the app behind a single
// trusted reverse proxy (e.g. nginx) sets TRUST_PROXY=true; then we use the LAST
// hop — the IP the proxy itself appended — not the spoofable left-most entry.
function getClientKey(req: NextApiRequest): string {
  const socketIp = req.socket?.remoteAddress ?? "unknown";
  if (process.env.TRUST_PROXY !== "true") return socketIp;
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || forwarded.trim().length === 0) return socketIp;
  const hops = forwarded
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : socketIp;
}

// Returns a handler wrapper that enforces rate limits per client IP.
// Usage: export default rateLimit({ windowMs: 60000, maxRequests: 10 })(handler)
export function rateLimit(config: RateLimitConfig) {
  return function wrap(
    handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void | NextApiResponse>,
  ) {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      const now = Date.now();
      const key = getClientKey(req);
      const cutoff = now - config.windowMs;

      pruneExpired(config.windowMs);

      let entry = store.get(key);
      if (!entry) {
        entry = { timestamps: [] };
        store.set(key, entry);
      }

      // Drop timestamps outside the window
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

      if (entry.timestamps.length >= config.maxRequests) {
        const retryAfter = Math.ceil((entry.timestamps[0] + config.windowMs - now) / 1000);
        res.setHeader("Retry-After", retryAfter.toString());
        res.setHeader("X-RateLimit-Limit", config.maxRequests.toString());
        res.setHeader("X-RateLimit-Remaining", "0");
        return res.status(429).json({
          error: "Too many requests",
          code: "RATE_LIMIT_EXCEEDED",
          retryAfter,
        });
      }

      entry.timestamps.push(now);

      res.setHeader("X-RateLimit-Limit", config.maxRequests.toString());
      res.setHeader(
        "X-RateLimit-Remaining",
        (config.maxRequests - entry.timestamps.length).toString(),
      );

      return handler(req, res);
    };
  };
}
