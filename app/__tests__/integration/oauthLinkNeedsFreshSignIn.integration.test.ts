// /app/__tests__/integration/oauthLinkNeedsFreshSignIn.integration.test.ts
//
// An OAuth sign-in that arrives while someone is signed in must not join the new
// account onto the signed-in person (2026-11-21).
//
// NextAuth's callback handler (next-auth 4.24, core/lib/callback-handler.js) takes
// the user from the session cookie, and when the incoming Google account is linked
// to nobody it calls the adapter's linkAccount onto THAT user. The signIn callback
// only asks whether the incoming email belongs to some active staff member. So a
// Designer at a browser where the Owner was signed in could finish Google consent
// with their own account and leave an Account row pointing at the Owner's User:
// every later Google sign-in with it was the Owner.
//
// This drives the real [...nextauth] handler, the real NextAuth core and the real
// Prisma adapter against the test database. Only the identity provider is stood in
// for: buildAuthProvidersAsync returns one OAuth provider, id "google", whose token
// and userinfo requests answer locally instead of over the network. Everything from
// the callback route on -- the session cookie decode, getUserByAccount, signIn,
// callback-handler, linkAccount, the jwt callback and the cookie written back -- is
// the code that ships.

const idp = { profile: { sub: "", email: "", name: "" } };

jest.mock("@/lib/auth/authProviders", () => {
  const actual = jest.requireActual("@/lib/auth/authProviders");
  const google = {
    id: "google",
    name: "Google",
    type: "oauth",
    clientId: "test-client",
    clientSecret: "test-secret",
    checks: [],
    authorization: { url: "https://idp.invalid/authorize", params: {} },
    token: {
      url: "https://idp.invalid/token",
      request: async () => ({ tokens: { access_token: "test-access", token_type: "bearer" } }),
    },
    userinfo: { url: "https://idp.invalid/userinfo", request: async () => idp.profile },
    profile: (p: { sub: string; email: string; name: string }) => ({
      id: p.sub,
      email: p.email,
      name: p.name,
      image: null,
    }),
  };
  return {
    ...actual,
    buildAuthProviders: () => [],
    buildAuthProvidersAsync: async () => [google],
  };
});

import type { NextApiRequest, NextApiResponse } from "next";
import { encode, decode } from "next-auth/jwt";

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import nextAuthHandler, { authOptions } from "@/pages/api/auth/[...nextauth]";
import { SignInLinkRefusedError } from "@/lib/auth/signInAccounts";

const SECRET = "oauth-link-test-secret-oauth-link-test-secret";
const COOKIE = "next-auth.session-token";
const env = { secret: process.env.NEXTAUTH_SECRET, url: process.env.NEXTAUTH_URL };

interface Reply {
  status: number;
  location: string | undefined;
  setCookie: string[];
}

/** Run the real NextAuth API handler for one request, the way Next calls it. */
async function nextAuth(
  route: string[],
  {
    query = {},
    cookies = {},
  }: { query?: Record<string, string>; cookies?: Record<string, string> },
): Promise<Reply> {
  const headers: Record<string, string | string[]> = {};
  const reply: Reply = { status: 200, location: undefined, setCookie: [] };
  const res = {
    status(code: number) {
      reply.status = code;
      return this;
    },
    setHeader(name: string, value: string | string[]) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    end() {
      return this;
    },
    send() {
      return this;
    },
    json() {
      return this;
    },
  };
  const req = {
    method: "GET",
    query: { nextauth: route, ...query },
    cookies,
    headers: { host: "localhost:3000" },
    body: undefined,
  };
  await nextAuthHandler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  const raw = headers["set-cookie"];
  reply.setCookie = raw === undefined ? [] : ([] as string[]).concat(raw);
  reply.location = headers.location as string | undefined;
  return reply;
}

/** The Google callback for `idp.profile`, at a browser holding `cookies`. */
function googleCallback(cookies: Record<string, string>) {
  return nextAuth(["callback", "google"], { query: { code: "test-code" }, cookies });
}

/** A session cookie for a signed-in user, as NextAuth itself encodes one. */
function sessionCookieFor(userId: string, email: string) {
  return encode({ token: { sub: userId, id: userId, email }, secret: SECRET });
}

/** The session the reply leaves in the browser: the last value it set for the cookie. */
async function sessionLeft(reply: Reply) {
  const set = reply.setCookie
    .filter((c) => c.startsWith(`${COOKIE}=`))
    .map((c) => c.slice(COOKIE.length + 1).split(";")[0]);
  const last = set.at(-1);
  if (!last) return null;
  return decode({ token: last, secret: SECRET });
}

async function makeStaff(
  roleKey: string,
  email: string,
  { userId }: { userId?: string } = {},
): Promise<{ id: number }> {
  if (userId) await prisma.user.create({ data: { id: userId, email } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  return prisma.staffMember.create({
    data: {
      userId: userId ?? null,
      email,
      displayName: email.split("@")[0],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      role: roleKey as any,
      roleId: role.id,
    },
  });
}

beforeAll(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
  process.env.NEXTAUTH_URL = "http://localhost:3000";
});

afterAll(async () => {
  process.env.NEXTAUTH_SECRET = env.secret;
  process.env.NEXTAUTH_URL = env.url;
  if (env.secret === undefined) delete process.env.NEXTAUTH_SECRET;
  if (env.url === undefined) delete process.env.NEXTAUTH_URL;
  await prisma.$disconnect();
});

let ownerCookie: string;

beforeEach(async () => {
  await resetTestDb();
  await syncBuiltInRoles({ prisma });
  invalidateRoleGrantCache();
  await makeStaff("SUPER_ADMIN", "owner@example.com", { userId: "owner" });
  ownerCookie = await sessionCookieFor("owner", "owner@example.com");
});

describe("a Google sign-in at a browser where the Owner is signed in", () => {
  it("signs in the Designer it belongs to, and links nothing onto the Owner", async () => {
    // A Designer who signs in with Google and has never done so: no User yet.
    const designer = await makeStaff("DESIGNER", "designer@example.com");
    idp.profile = { sub: "google-designer", email: "designer@example.com", name: "Designer" };

    const reply = await googleCallback({ [COOKIE]: ownerCookie });

    expect(await prisma.account.count({ where: { userId: "owner" } })).toBe(0);
    const account = await prisma.account.findUniqueOrThrow({
      where: {
        provider_providerAccountId: { provider: "google", providerAccountId: "google-designer" },
      },
    });
    const linked = await prisma.staffMember.findUniqueOrThrow({ where: { id: designer.id } });
    expect(linked.userId).toBe(account.userId);

    // The browser now holds the Designer's session, not the Owner's.
    expect(reply.location).not.toMatch(/error/);
    const session = await sessionLeft(reply);
    expect(session?.sub).toBe(account.userId);
    expect(session?.sub).not.toBe("owner");
  });

  it("ends the Owner's cookie before writing the new one, so no old piece survives", async () => {
    await makeStaff("DESIGNER", "designer@example.com");
    idp.profile = { sub: "google-designer", email: "designer@example.com", name: "Designer" };

    const reply = await googleCallback({ [COOKIE]: ownerCookie, [`${COOKIE}.1`]: "stale" });

    const cleared = reply.setCookie.filter((c) => /^next-auth\.session-token(\.\d+)?=;/.test(c));
    expect(cleared.map((c) => c.split("=")[0]).sort()).toEqual([COOKIE, `${COOKIE}.1`]);
    for (const c of cleared) expect(c).toMatch(/Max-Age=0/);
    const firstNew = reply.setCookie.findIndex((c) => /^next-auth\.session-token=[^;]/.test(c));
    expect(firstNew).toBeGreaterThan(reply.setCookie.indexOf(cleared[0]));
  });

  it("records the link on the audit trail", async () => {
    await makeStaff("DESIGNER", "designer@example.com");
    idp.profile = { sub: "google-designer", email: "designer@example.com", name: "Designer" };

    await googleCallback({ [COOKIE]: ownerCookie });

    const account = await prisma.account.findFirstOrThrow();
    const entries = await prisma.auditEntry.findMany({ where: { event: "SIGN_IN_LINKED" } });
    expect(entries).toHaveLength(1);
    expect(entries[0].actor).toBe("designer@example.com");
    expect(entries[0].details).toMatchObject({
      provider: "google",
      providerAccountId: "google-designer",
      userId: account.userId,
    });
  });

  it("refuses a Designer who already has a sign-in, and links nothing anywhere", async () => {
    // A Designer whose User row exists (a local password set by an admin).
    await makeStaff("DESIGNER", "designer@example.com", { userId: "designer" });
    idp.profile = { sub: "google-designer", email: "designer@example.com", name: "Designer" };

    const reply = await googleCallback({ [COOKIE]: ownerCookie });

    expect(await prisma.account.count()).toBe(0);
    expect(reply.location).toMatch(/error=OAuthAccountNotLinked/);
    expect(await sessionLeft(reply)).toBeNull();
  });

  it("still signs the Owner in with their own, already linked, Google account", async () => {
    await prisma.account.create({
      data: {
        userId: "owner",
        type: "oauth",
        provider: "google",
        providerAccountId: "google-owner",
      },
    });
    idp.profile = { sub: "google-owner", email: "owner@example.com", name: "Owner" };

    const reply = await googleCallback({});

    expect(reply.location).not.toMatch(/error/);
    expect((await sessionLeft(reply))?.sub).toBe("owner");
  });
});

describe("the adapter's link, whatever path reaches it", () => {
  // Through the adapter NextAuth is actually given, so putting a plain
  // PrismaAdapter back in authOptions fails these, not only a hand-built copy.
  const link = (userId: string, providerAccountId: string) =>
    authOptions.adapter!.linkAccount!({
      userId,
      type: "oauth",
      provider: "google",
      providerAccountId,
    });

  it("refuses to join an account onto someone who is already a staff member's sign-in", async () => {
    await expect(link("owner", "google-someone-else")).rejects.toBeInstanceOf(
      SignInLinkRefusedError,
    );
    expect(await prisma.account.count()).toBe(0);
    const refused = await prisma.auditEntry.findMany({ where: { event: "SIGN_IN_LINK_REFUSED" } });
    expect(refused).toHaveLength(1);
    expect(refused[0].details).toMatchObject({
      provider: "google",
      providerAccountId: "google-someone-else",
      userId: "owner",
    });
  });

  it("links onto a User no staff member signs in as yet, as a first sign-in creates", async () => {
    await prisma.user.create({ data: { id: "fresh", email: "fresh@example.com" } });
    await link("fresh", "google-fresh");
    expect(await prisma.account.count({ where: { userId: "fresh" } })).toBe(1);
  });
});
