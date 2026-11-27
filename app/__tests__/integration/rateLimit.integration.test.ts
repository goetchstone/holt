// /app/__tests__/integration/rateLimit.integration.test.ts
//
// lib/rateLimit.ts against a real database. The point of keeping the count in
// Postgres is that the limit holds across app processes, so the central test
// runs the limiter from TWO module instances (jest.isolateModules gives the
// second its own module state, as a second process would have) and alternates
// requests between them. The in-memory limiter this replaced let each instance
// allow the full limit, so it fails that test; this one must not.

import type { NextApiRequest, NextApiResponse } from "next";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import * as limiterA from "@/lib/rateLimit";

type Limiter = typeof limiterA;

let limiterB!: Limiter;
jest.isolateModules(() => {
  limiterB = require("@/lib/rateLimit");
});

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  headers: Record<string, string>;
}

function makeRes(): TestRes {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as TestRes;
  return res;
}

function makeReq(ip: string): NextApiRequest {
  return { headers: {}, socket: { remoteAddress: ip } } as unknown as NextApiRequest;
}

const MINUTE = { windowMs: 60_000, maxRequests: 3 };

// The limiter's windows are fixed to the clock (windowStartFor), so requests
// that straddled a minute boundary started a new count and the test read
// [200, 200, 200, 200, ...] (2026-11-24). Every test here assumes its requests
// share a window, so the clock is held in the middle of one.
let clock: jest.SpyInstance<number, []>;

beforeEach(async () => {
  await resetTestDb();
  const midWindow = limiterA.windowStartFor(Date.now(), MINUTE.windowMs) + MINUTE.windowMs / 2;
  clock = jest.spyOn(Date, "now").mockReturnValue(midWindow);
});

afterEach(() => {
  clock.mockRestore();
});

afterAll(async () => {
  await prisma.$disconnect();
});

it("holds one limit across two app processes", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    const limiter = i % 2 === 0 ? limiterA : limiterB;
    const res = makeRes();
    const allowed = await limiter.checkRateLimit(makeReq("203.0.113.10"), res, MINUTE, "login");
    statuses.push(allowed ? 200 : res.statusCode);
  }
  // Three allowed between them, not three each.
  expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
});

it("answers the limit with 429, Retry-After and the remaining count", async () => {
  const handler = jest.fn(async (_req: NextApiRequest, res: NextApiResponse) => {
    res.status(200).json({ ok: true });
  });
  const wrapped = limiterA.rateLimit(MINUTE, "portal-pay")(handler);

  const remaining: string[] = [];
  for (let i = 0; i < 3; i++) {
    const res = makeRes();
    await wrapped(makeReq("203.0.113.11"), res);
    remaining.push(res.headers["X-RateLimit-Remaining"]);
  }
  expect(remaining).toEqual(["2", "1", "0"]);

  const res = makeRes();
  await wrapped(makeReq("203.0.113.11"), res);
  expect(handler).toHaveBeenCalledTimes(3);
  expect(res.statusCode).toBe(429);
  expect(res.body).toMatchObject({ error: "Too many requests", code: "RATE_LIMIT_EXCEEDED" });
  const retryAfter = Number(res.headers["Retry-After"]);
  expect(retryAfter).toBeGreaterThanOrEqual(1);
  expect(retryAfter).toBeLessThanOrEqual(60);
});

it("keeps clients and routes apart", async () => {
  const one = { windowMs: 60_000, maxRequests: 1 };
  expect(await limiterA.checkRateLimit(makeReq("203.0.113.20"), makeRes(), one, "tickets")).toBe(
    true,
  );
  expect(await limiterA.checkRateLimit(makeReq("203.0.113.20"), makeRes(), one, "tickets")).toBe(
    false,
  );
  // Another client on the same route, and the same client on another route.
  expect(await limiterB.checkRateLimit(makeReq("203.0.113.21"), makeRes(), one, "tickets")).toBe(
    true,
  );
  expect(
    await limiterB.checkRateLimit(makeReq("203.0.113.20"), makeRes(), one, "blog-comments"),
  ).toBe(true);
});

it("counts in one row per client, route and window, which expires with the window", async () => {
  const before = Date.now();
  await limiterA.checkRateLimit(makeReq("203.0.113.30"), makeRes(), MINUTE, "login");
  await limiterB.checkRateLimit(makeReq("203.0.113.30"), makeRes(), MINUTE, "login");
  const rows = await prisma.rateLimitWindow.findMany();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ bucket: "login", clientKey: "203.0.113.30", count: 2 });
  // Written by raw SQL and read back by Prisma: the window must be the moment
  // the code meant, not shifted by a time zone on the way in.
  const start = rows[0].windowStart.getTime();
  expect(start).toBe(limiterA.windowStartFor(before, MINUTE.windowMs));
  expect(rows[0].expiresAt.getTime()).toBe(start + MINUTE.windowMs);
});

it("deletes expired windows as it goes", async () => {
  await prisma.rateLimitWindow.create({
    data: {
      bucket: "login",
      clientKey: "198.51.100.1",
      windowStart: new Date(Date.now() - 3_600_000),
      count: 9,
      expiresAt: new Date(Date.now() - 3_000_000),
    },
  });
  // A fresh module instance has not pruned yet, so its first check does.
  let limiterC!: Limiter;
  jest.isolateModules(() => {
    limiterC = require("@/lib/rateLimit");
  });
  await limiterC.checkRateLimit(makeReq("203.0.113.40"), makeRes(), MINUTE, "login");
  const left = await prisma.rateLimitWindow.findMany({ select: { clientKey: true } });
  expect(left).toEqual([{ clientKey: "203.0.113.40" }]);
});
