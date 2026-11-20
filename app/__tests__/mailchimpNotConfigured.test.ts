// /app/__tests__/mailchimpNotConfigured.test.ts
//
// A deployment without a usable MAILCHIMP_API_KEY. The campaigns route and three
// sync routes built `https://.api.mailchimp.com` from the missing datacenter and
// answered the DNS failure with a 500 (and an ops alert), on every load of the
// Leads screen. Found by the browser smoke suite on 2026-11-20. Each route now
// checks the key per request: the campaigns read says "not configured" with an
// empty list, and the sync actions refuse with one shared message, as
// sync-all-activity already did. No request leaves the box either way.

import type { NextApiRequest, NextApiResponse } from "next";

jest.mock("@/lib/auth/requireAuth", () => ({
  // Bypass auth; the gates are covered by the apiRouteAuthorization tripwire.
  requirePermission:
    (_permission: string, handler: (...a: unknown[]) => unknown) => (req: unknown, res: unknown) =>
      handler(req, res, { user: { email: "admin@example.com" } }),
}));

const axiosCalls: string[] = [];
jest.mock("axios", () => {
  const record = (method: string) => (url: string) => {
    axiosCalls.push(`${method} ${url}`);
    return Promise.reject(new Error("no network in this test"));
  };
  const axios = { get: record("GET"), post: record("POST"), isAxiosError: () => false };
  return { __esModule: true, default: axios, ...axios };
});

type Handler = (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

/** Loads a route module with MAILCHIMP_API_KEY set to `key` (or unset). */
function load(path: string, key: string | undefined): Handler {
  let handler: Handler | undefined;
  jest.isolateModules(() => {
    if (key === undefined) delete process.env.MAILCHIMP_API_KEY;
    else process.env.MAILCHIMP_API_KEY = key;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    handler = require(path).default as Handler;
  });
  return handler!;
}

function call(handler: Handler, method: string, body: unknown = {}) {
  const res = {
    statusCode: 0,
    payload: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(p: unknown) {
      this.payload = p;
      return this;
    },
    end() {
      return this;
    },
    setHeader() {
      return this;
    },
  };
  const req = { method, query: {}, body, headers: {} } as unknown as NextApiRequest;
  return handler(req, res as unknown as NextApiResponse).then(() => res);
}

const SYNC_ROUTES = [
  "@/pages/api/mailchimp/sync",
  "@/pages/api/mailchimp/sync-activity",
  "@/pages/api/mailchimp/sync-metrics",
  "@/pages/api/mailchimp/sync-all-activity",
];

// Unset, and a key whose datacenter suffix is not one (mailchimpDatacenter -> null).
describe.each([
  ["unset", undefined],
  ["malformed", "abc123-evil.example.com/"],
])("MAILCHIMP_API_KEY %s", (_label, key) => {
  const saved = process.env.MAILCHIMP_API_KEY;
  beforeEach(() => {
    axiosCalls.length = 0;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.MAILCHIMP_API_KEY;
    else process.env.MAILCHIMP_API_KEY = saved;
  });

  it("the campaigns read returns an empty list marked not configured", async () => {
    const res = await call(load("@/pages/api/mailchimp/campaigns", key), "GET");
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ campaigns: [], configured: false });
    expect(axiosCalls).toEqual([]);
  });

  it.each(SYNC_ROUTES)("%s refuses with the shared message", async (route) => {
    const { MAILCHIMP_NOT_CONFIGURED } = await import("@/lib/mailchimp/baseUrl");
    const res = await call(load(route, key), "POST", { campaignId: "a1b2c3d4e5" });
    expect(res.statusCode).toBe(400);
    expect(res.payload).toEqual({ error: MAILCHIMP_NOT_CONFIGURED });
    expect(axiosCalls).toEqual([]);
  });
});
