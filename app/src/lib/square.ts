// /app/src/lib/square.ts
//
// Square REST client. Mirrors lib/stripe.ts: credentials are DB-first with an
// env fallback (resolveCredential), cached and rebuilt when the resolved
// value changes.
//
// SDK vs REST: this project talks to Square over `fetch` rather than the
// official `square` npm package. The package (currently v45) pulls in a
// second copy of itself as a dependency -- `square-legacy: npm:square@^39.1.1`,
// the entire previous major bundled in for backward compatibility -- plus
// node-fetch, form-data, formdata-node, form-data-encoder and readable-stream,
// polyfills for a fetch/FormData/ReadableStream that Node (this app targets
// Node 18+, and runs on 24) already ships natively. That's a large,
// self-duplicating dependency surface (~12MB unpacked for `square` alone) to
// take on for the handful of endpoints Holt actually needs: create a payment
// link, retrieve an order, refund a payment, list locations. A thin `fetch`
// wrapper covers all four in well under 100 lines with zero new dependencies
// and nothing new for `npm audit`/osv-scanner to track (CLAUDE.md rules 1, 52-55).
//
import { resolveCredential } from "@/lib/integrationCredentials";

// The API version is pinned explicitly via the Square-Version header, the
// same way stripe.ts pins `apiVersion` -- so a future Square release can't
// silently change response shapes under us. Bump deliberately, not by drift.
const SQUARE_API_VERSION = "2026-07-15";

// Square's REST host. No DB/Settings field for this -- every Holt deployment
// talks to production Square. SQUARE_API_BASE_URL is an env-only escape hatch
// (unset in production) for pointing a dev/test run at Square's sandbox host,
// the same spirit as STRIPE_TEST_EMAIL_OVERRIDE in stripe.ts.
const SQUARE_API_BASE_URL = (
  process.env.SQUARE_API_BASE_URL || "https://connect.squareup.com"
).replace(/\/+$/, "");

export interface SquareCredentials {
  accessToken: string;
  locationId: string;
}

// Cache the resolved credentials AND the key they were built from. If either
// value changes (operator updates them in Settings), the cache is rebuilt
// rather than serving a stale token/location.
let _square: { key: string; creds: SquareCredentials } | null = null;

/**
 * Resolve Square's credentials. DB-first (Settings) with an env fallback
 * (SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID), so a value configured in the
 * admin UI takes effect without a redeploy -- same contract as getStripe().
 */
export async function getSquareCredentials(): Promise<SquareCredentials> {
  const accessToken = await resolveCredential("square", "accessToken", "SQUARE_ACCESS_TOKEN");
  const locationId = await resolveCredential("square", "locationId", "SQUARE_LOCATION_ID");
  if (!accessToken || !locationId) {
    throw new Error(
      "Square is not configured: set the Square access token and location ID in " +
        "Settings > Integrations, or the SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID " +
        "environment variables.",
    );
  }
  const key = `${accessToken}:${locationId}`;
  if (!_square || _square.key !== key) {
    _square = { key, creds: { accessToken, locationId } };
  }
  return _square.creds;
}

/** Thrown for a non-2xx Square response. Carries the HTTP status and parsed
 *  body so callers can surface a real message via getErrorMessage-style
 *  handling rather than a generic "Failed to X". */
export class SquareApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "SquareApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Minimal typed wrapper over Square's REST API. Every call resolves fresh
 * (cached) credentials, sends the pinned Square-Version header, and throws
 * SquareApiError on a non-2xx response with Square's own error detail.
 */
export async function squareRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { accessToken } = await getSquareCredentials();

  const res = await fetch(`${SQUARE_API_BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Square-Version": SQUARE_API_VERSION,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });

  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const errors = (json as { errors?: { detail?: string; code?: string }[] })?.errors;
    const detail = errors?.[0]?.detail || errors?.[0]?.code;
    throw new SquareApiError(
      detail ? `Square API error: ${detail}` : `Square API request failed (HTTP ${res.status})`,
      res.status,
      json,
    );
  }

  return json as T;
}
