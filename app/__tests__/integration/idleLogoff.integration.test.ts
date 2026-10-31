// /app/__tests__/integration/idleLogoff.integration.test.ts
//
// GAP-27: a session ends after the store's idle time, at every gate, and only a
// person at the screen restarts it.
//
// The session is a NextAuth JWT whose expiry lib/auth/sessionToken.ts sets from
// the token's `lastActiveAt`. Nothing here mocks next-auth: tokens are minted by
// the real encoder and read by the real readers each gate uses -- getServerSession
// behind the API gates, getToken behind requirePage and the tRPC context -- and
// the activity report goes through the real NextAuth route, CSRF check and all.
// Only next/headers and redirect are stand-ins, as in sessionEnded.integration.
// Real database: the idle time is the AppSettings row.

jest.mock("next/headers", () => ({ cookies: jest.fn(), headers: jest.fn() }));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  }),
}));

import { createHash, randomBytes } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { decode, type JWT } from "next-auth/jwt";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { requirePermission } from "@/lib/auth/requireAuth";
import { requirePage } from "@/lib/auth/requirePage";
import { createContext } from "@/server/trpc/context";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { SERVER_GRACE_MS } from "@/lib/auth/idleLogoff";
import { SESSION_CEILING_SECONDS, encodeSessionToken } from "@/lib/auth/sessionToken";
import authHandler, { authOptions } from "@/pages/api/auth/[...nextauth]";
import settingsRoute from "@/pages/api/admin/settings/index";

const COOKIE = "next-auth.session-token";
const CSRF_COOKIE = "next-auth.csrf-token";
const MINUTE = 60_000;

// The test job sets neither; restore whatever was there for the next file.
const savedEnv = { secret: process.env.NEXTAUTH_SECRET, url: process.env.NEXTAUTH_URL };
const SECRET = authOptions.secret ?? savedEnv.secret ?? "idle-logoff-integration-secret";

async function setIdleMinutes(minutes: number) {
  await prisma.appSettings.update({
    where: { organizationId: DEFAULT_ORG_ID },
    data: { idleLogoffMinutes: minutes },
  });
  invalidateAppSettingsCache();
}

/** A session token for "ada", last active `idleFor` ms ago. */
function mint(idleFor: number, extra: Partial<JWT> = {}): Promise<string> {
  return encodeSessionToken({
    token: { id: "ada", email: "ada@example.com", lastActiveAt: Date.now() - idleFor, ...extra },
    secret: SECRET,
    maxAge: SESSION_CEILING_SECONDS,
  });
}

async function claims(token: string): Promise<JWT & { exp: number }> {
  return (await decode({ token, secret: SECRET })) as JWT & { exp: number };
}

/** A response that keeps what a handler sets. */
function fakeRes() {
  const out = { status: 200, body: undefined as unknown, headers: {} as Record<string, unknown> };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(payload: unknown) {
      out.body = payload;
      return res;
    },
    send(payload: unknown) {
      out.body = payload;
      return res;
    },
    end() {
      return res;
    },
    setHeader(name: string, value: unknown) {
      out.headers[name.toLowerCase()] = value;
      return res;
    },
    getHeader(name: string) {
      return out.headers[name.toLowerCase()];
    },
  };
  return { res: res as unknown as NextApiResponse, out };
}

/** The session token a response set, if it set one. */
function tokenSet(out: ReturnType<typeof fakeRes>["out"]): string | null {
  const raw = out.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const line of all as string[]) {
    const [pair] = line.split(";");
    const [name, ...value] = pair.split("=");
    if (name === COOKIE && value.join("=")) return value.join("=");
  }
  return null;
}

function apiReq(token: string, extra: Record<string, unknown> = {}): NextApiRequest {
  return {
    method: "GET",
    query: {},
    headers: { host: "localhost:3000", cookie: `${COOKIE}=${token}` },
    cookies: { [COOKIE]: token },
    ...extra,
  } as unknown as NextApiRequest;
}

async function callApi(token: string): Promise<number> {
  const { res, out } = fakeRes();
  await requirePermission("admin.settings", async (_req, r) => {
    r.status(200).json({ ok: true });
  })(apiReq(token), res);
  return out.status;
}

async function openPage(token: string): Promise<string> {
  (headers as jest.Mock).mockResolvedValue(new Headers({ cookie: `${COOKIE}=${token}` }));
  (cookies as jest.Mock).mockResolvedValue({
    getAll: () => [{ name: COOKIE, value: token }],
    get: (name: string) => (name === COOKIE ? { name, value: token } : undefined),
  });
  try {
    await requirePage(undefined, { permission: "admin.settings" });
    return "rendered";
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("REDIRECT ")) return e.message;
    throw e;
  }
}

async function trpcUser(token: string): Promise<string | null> {
  // The App Router hands the context a NextRequest, whose cookies have getAll.
  const req = {
    headers: new Headers({ cookie: `${COOKIE}=${token}` }),
    cookies: { getAll: () => [{ name: COOKIE, value: token }] },
  };
  return (await createContext({ req: req as unknown as Request })).userId;
}

/** A background request: what TopNav's notification poll does to the session. */
async function backgroundRead(token: string) {
  const { res, out } = fakeRes();
  const session = await getServerSession(apiReq(token), res, authOptions);
  return { session, token: tokenSet(out) };
}

/** IdleLogoff's report: POST /api/auth/session { data: { active: true } } with CSRF. */
async function reportActivity(token: string, data: unknown = { active: true }) {
  const csrf = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(`${csrf}${SECRET}`).digest("hex");
  const cookiePair = `${CSRF_COOKIE}=${csrf}|${hash}`;
  const { res, out } = fakeRes();
  await authHandler(
    apiReq(token, {
      method: "POST",
      query: { nextauth: ["session"] },
      headers: {
        host: "localhost:3000",
        "content-type": "application/json",
        cookie: `${COOKIE}=${token}; ${cookiePair}`,
      },
      cookies: { [COOKIE]: token, [CSRF_COOKIE]: `${csrf}|${hash}` },
      body: { csrfToken: csrf, data },
    }),
    res,
  );
  return { status: out.status, token: tokenSet(out), body: out.body };
}

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
  // An https NEXTAUTH_URL would make getToken look for the __Secure- cookie.
  delete process.env.NEXTAUTH_URL;
});

afterAll(async () => {
  if (savedEnv.secret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = savedEnv.secret;
  if (savedEnv.url !== undefined) process.env.NEXTAUTH_URL = savedEnv.url;
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await syncBuiltInRoles({ prisma });
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Co", slug: "test-co" },
  });
  await prisma.appSettings.create({ data: { organizationId: DEFAULT_ORG_ID, timezone: "UTC" } });
  invalidateAppSettingsCache();
  await prisma.user.create({ data: { id: "ada", email: "ada@example.com" } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: "ADMIN" } });
  await prisma.staffMember.create({
    data: {
      userId: "ada",
      displayName: "Ada",
      email: "ada@example.com",
      role: "ADMIN",
      roleId: role.id,
    },
  });
});

describe("the store's idle time", () => {
  it("is 15 minutes out of the box, and the session tells the browser so", async () => {
    const settings = await prisma.appSettings.findUniqueOrThrow({
      where: { organizationId: DEFAULT_ORG_ID },
    });
    expect(settings.idleLogoffMinutes).toBe(15);
    const { session } = await backgroundRead(await mint(0));
    expect(session?.idleLogoffMinutes).toBe(15);
  });

  it("is refused by the database outside 5-720 and 0", async () => {
    for (const bad of [-1, 1, 4, 721]) {
      await expect(setIdleMinutes(bad)).rejects.toThrow(/idleLogoffMinutes_range/);
    }
    for (const good of [0, 5, 720]) await setIdleMinutes(good);
  });
});

describe("a session idle past the store's time", () => {
  // 15 minutes plus the 2-minute grace has passed.
  const IDLE = 18 * MINUTE;

  it("is refused by an API gate, a page and tRPC alike", async () => {
    const stale = await mint(IDLE);
    expect(await callApi(stale)).toBe(401);
    expect(await openPage(stale)).toBe("REDIRECT /auth/login");
    expect(await trpcUser(stale)).toBeNull();
  });

  it("can't be revived by reporting activity", async () => {
    const out = await reportActivity(await mint(IDLE));
    expect(out.token).toBeNull();
    expect(out.body).toEqual({});
  });

  it("follows a store that allows longer", async () => {
    await setIdleMinutes(30);
    const token = await mint(IDLE);
    expect(await callApi(token)).toBe(200);
    expect(await openPage(token)).toBe("rendered");
    expect(await trpcUser(token)).toBe("ada");
  });

  it("never ends when the store has turned it off", async () => {
    await setIdleMinutes(0);
    const token = await mint(29 * 24 * 60 * MINUTE);
    expect(await callApi(token)).toBe(200);
    expect((await claims(token)).exp * 1000).toBeGreaterThan(Date.now() + 29 * 24 * 60 * MINUTE);
  });
});

describe("a session still inside its idle time", () => {
  it("is admitted everywhere", async () => {
    const fresh = await mint(10 * MINUTE);
    expect(await callApi(fresh)).toBe(200);
    expect(await openPage(fresh)).toBe("rendered");
    expect(await trpcUser(fresh)).toBe("ada");
  });

  it("expires at last activity + idle time + grace, not at now + anything", async () => {
    const lastActiveAt = Date.now() - 10 * MINUTE;
    const token = await mint(10 * MINUTE, { lastActiveAt });
    const exp = (await claims(token)).exp * 1000;
    expect(Math.abs(exp - (lastActiveAt + 15 * MINUTE + SERVER_GRACE_MS))).toBeLessThan(2_000);
  });

  it("is not kept alive by background requests", async () => {
    const lastActiveAt = Date.now() - 10 * MINUTE;
    const before = await mint(10 * MINUTE, { lastActiveAt });
    const read = await backgroundRead(before);
    expect(read.session?.user.id).toBe("ada");
    expect(read.token).not.toBeNull();
    const after = await claims(read.token as string);
    expect(after.lastActiveAt).toBe(lastActiveAt);
    expect(after.exp).toBe((await claims(before)).exp);
  });

  it("restarts when the browser reports someone at the screen", async () => {
    const before = await mint(10 * MINUTE);
    const started = Date.now();
    const out = await reportActivity(before);
    expect(out.status).toBe(200);
    expect(out.token).not.toBeNull();
    const after = await claims(out.token as string);
    expect(after.lastActiveAt as number).toBeGreaterThanOrEqual(started);
    expect(after.exp * 1000).toBeGreaterThanOrEqual(
      started + 15 * MINUTE + SERVER_GRACE_MS - 1_000,
    );
  });

  it("takes the server's clock, not a time the browser sends", async () => {
    const lastActiveAt = Date.now() - 10 * MINUTE;
    const before = await mint(10 * MINUTE, { lastActiveAt });
    const future = Date.now() + 365 * 24 * 60 * MINUTE;
    const claimed = await reportActivity(before, { lastActiveAt: future });
    expect((await claims(claimed.token as string)).lastActiveAt).toBe(lastActiveAt);
    const reported = await reportActivity(before, { active: true, lastActiveAt: future });
    expect((await claims(reported.token as string)).lastActiveAt as number).toBeLessThan(future);
  });

  it("shortens at the next request when the store lowers the time", async () => {
    const token = await mint(10 * MINUTE);
    expect(await callApi(token)).toBe(200);
    await setIdleMinutes(5);
    // This request still carries the old expiry; the token it gets back doesn't.
    const reissued = await backgroundRead(token);
    expect(reissued.session).not.toBeNull();
    expect(await callApi(reissued.token as string)).toBe(401);
  });
});

describe("a session issued before automatic sign-out", () => {
  it("gets one idle time from its next request", async () => {
    const legacy = await encodeSessionToken({
      token: { id: "ada", email: "ada@example.com" },
      secret: SECRET,
      maxAge: SESSION_CEILING_SECONDS,
    });
    const started = Date.now();
    const read = await backgroundRead(legacy);
    expect(read.session?.user.id).toBe("ada");
    expect((await claims(read.token as string)).lastActiveAt as number).toBeGreaterThanOrEqual(
      started,
    );
  });
});

describe("setting the idle time (Settings)", () => {
  it("takes 5-720 minutes or 0 for off, refuses anything else, and reaches the browser", async () => {
    const token = await mint(0);
    const put = async (body: unknown) => {
      const { res, out } = fakeRes();
      await settingsRoute(apiReq(token, { method: "PUT", body }), res);
      return out;
    };
    for (const bad of [4, 721, 12.5, -5, "15", null]) {
      const out = await put({ idleLogoffMinutes: bad });
      expect(out.status).toBe(400);
      expect(out.body).toEqual({
        error: expect.stringContaining("idleLogoffMinutes must be 0 (off) or a whole number"),
      });
    }
    const saved = await put({ idleLogoffMinutes: 30 });
    expect(saved.status).toBe(200);
    expect((saved.body as { settings: { idleLogoffMinutes: number } }).settings).toMatchObject({
      idleLogoffMinutes: 30,
    });
    expect((await backgroundRead(token)).session?.idleLogoffMinutes).toBe(30);
    expect((await put({ idleLogoffMinutes: 0 })).status).toBe(200);
    expect((await backgroundRead(token)).session?.idleLogoffMinutes).toBe(0);
  });
});
