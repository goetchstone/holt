// /app/__tests__/cacheGeneration.test.ts
//
// PLACEHOLDER TEST — Grade: B (real snapshot logic, mocked SQL). The bump SQL and
// its effect on a second process run against Postgres in
// __tests__/integration/multiProcessCaches.integration.test.ts.
//
// The snapshot rules in lib/cacheGeneration.ts, without a database: a process
// reads the generations at most once per CACHE_GENERATION_CHECK_MS, shares one
// read among concurrent callers, re-reads at once after forgetCacheGenerations(),
// and answers UNREADABLE (never throws) when the table can't be read. What a bump
// does to a second process is tested for real in
// __tests__/integration/multiProcessCaches.integration.test.ts.

jest.mock("@/lib/prisma", () => ({
  prisma: { cacheGeneration: { findMany: jest.fn() } },
}));

import { prisma } from "@/lib/prisma";
import {
  CACHE_GENERATION_CHECK_MS,
  CACHE_GENERATION_KEYS,
  UNREADABLE,
  cacheGeneration,
  forgetCacheGenerations,
} from "@/lib/cacheGeneration";

const findMany = prisma.cacheGeneration.findMany as jest.Mock;

let now = 1_000_000;
const realNow = Date.now;

beforeEach(() => {
  findMany.mockReset();
  forgetCacheGenerations();
  now = 1_000_000;
  Date.now = () => now;
});

afterAll(() => {
  Date.now = realNow;
});

it("reads the generations at most once per check interval", async () => {
  findMany.mockResolvedValue([{ key: "roles", generation: BigInt(5) }]);
  expect(await cacheGeneration("roles")).toBe("5");
  now += CACHE_GENERATION_CHECK_MS - 1;
  findMany.mockResolvedValue([{ key: "roles", generation: BigInt(6) }]);
  expect(await cacheGeneration("roles")).toBe("5");
  expect(findMany).toHaveBeenCalledTimes(1);

  now += 1;
  expect(await cacheGeneration("roles")).toBe("6");
  expect(findMany).toHaveBeenCalledTimes(2);
});

it("shares one read among callers that arrive while it runs", async () => {
  findMany.mockResolvedValue([{ key: "settings", generation: BigInt(9) }]);
  const answers = await Promise.all([
    cacheGeneration("settings"),
    cacheGeneration("settings"),
    cacheGeneration("roles"),
  ]);
  expect(answers).toEqual(["9", "9", "0"]);
  expect(findMany).toHaveBeenCalledTimes(1);
});

it("re-reads at once after forgetCacheGenerations()", async () => {
  findMany.mockResolvedValue([{ key: "roles", generation: BigInt(1) }]);
  await cacheGeneration("roles");
  findMany.mockResolvedValue([{ key: "roles", generation: BigInt(2) }]);
  forgetCacheGenerations();
  expect(await cacheGeneration("roles")).toBe("2");
});

it("answers '0' for a key never bumped", async () => {
  findMany.mockResolvedValue([]);
  expect(await cacheGeneration("imports")).toBe("0");
});

it("answers UNREADABLE, not an error, when the table can't be read", async () => {
  findMany.mockRejectedValue(new Error('relation "CacheGeneration" does not exist'));
  expect(await cacheGeneration("roles")).toBe(UNREADABLE);
  // Held for the interval like any other read, rather than retried per call.
  expect(await cacheGeneration("settings")).toBe(UNREADABLE);
  expect(findMany).toHaveBeenCalledTimes(1);
});

it("names every cache once", () => {
  expect(new Set(CACHE_GENERATION_KEYS).size).toBe(CACHE_GENERATION_KEYS.length);
});
