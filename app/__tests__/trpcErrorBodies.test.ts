// /app/__tests__/trpcErrorBodies.test.ts
//
// A 500 says what failed, never why (rule 11), on tRPC as on REST. tRPC wraps
// anything a procedure throws that is not a TRPCError as INTERNAL_SERVER_ERROR,
// with the throw as its cause and the cause's own message as its message
// (@trpc/server 11, getTRPCErrorFromUnknown), and its default error shape puts
// that message in the response: a Prisma error's model and column names, which
// screens such as the invoice composer show. A TRPCError thrown on purpose keeps
// its message, INTERNAL_SERVER_ERROR included, because a screen shows it.
//
// Driven through the real HTTP route (app/api/trpc/[trpc]/route.ts: the fetch
// adapter, its onError and the real procedure builders and error formatter),
// with the real account router and a probe router built from the same
// builders. Prisma and the session cookie are stood in for. Loaded with
// NODE_ENV=production, as the server runs: tRPC adds the stack to an error's
// shape anywhere else, which is a development aid.
//
// PLACEHOLDER TEST — Grade: B (the real HTTP route, builders and formatter;
// Prisma stood in for only to throw or find nothing). No SQL is under test: what
// is checked is the body a failure gets, and a real database won't fail on
// demand, so no real-DB version is planned.

const findFirst = jest.fn();
jest.mock("@/lib/prisma", () => ({
  prisma: { staffMember: { findFirst: (...a: unknown[]) => findFirst(...a) } },
}));
const getToken = jest.fn();
jest.mock("next-auth/jwt", () => ({ getToken: (...a: unknown[]) => getToken(...a) }));
const logError = jest.fn();
jest.mock("@/lib/logger", () => ({
  ...jest.requireActual("@/lib/logger"),
  logError: (...a: unknown[]) => logError(...a),
}));

/** Prisma's own words, as a failed query throws them. */
const PRISMA_FAILURE = new Error(
  "\nInvalid `prisma.staffMember.findFirst()` invocation:\n\n" +
    "The column `StaffMember.payrollSecret` does not exist in the current database.",
);
const INTERNALS = /prisma|staffMember|payrollSecret|invocation|does not exist/i;

jest.mock("@/server/trpc/routers/_app", () => {
  const { router, publicProcedure } = jest.requireActual("@/server/trpc/trpc");
  const { accountRouter } = jest.requireActual("@/server/trpc/routers/account");
  const { TRPCError: Deliberate } = jest.requireActual("@trpc/server");
  const refuse = (code: string, message: string) =>
    publicProcedure.query(() => {
      throw new Deliberate({ code, message });
    });
  return {
    appRouter: router({
      account: accountRouter,
      probe: router({
        badRequest: refuse("BAD_REQUEST", "Invalid due date."),
        forbidden: refuse("FORBIDDEN", "Insufficient role."),
        notFound: refuse("NOT_FOUND", "Billing is not enabled."),
        conflict: refuse("CONFLICT", "A payment link is already open on this invoice."),
        deliberate500: publicProcedure.query(() => {
          throw new Deliberate({
            code: "INTERNAL_SERVER_ERROR",
            message: "The invoice's journal did not post.",
            cause: new Error("deadlock detected on relation JournalEntry"),
          });
        }),
        throwsString: publicProcedure.query(() => {
          throw "connect ECONNREFUSED 10.0.0.5:5432";
        }),
        throwsObject: publicProcedure.query(() => {
          throw { message: "relation StaffMember has no column payrollSecret" };
        }),
      }),
    }),
  };
});

type Handler = (req: Request) => Promise<Response>;
let GET: Handler;
let POST: Handler;

const env = process.env as Record<string, string | undefined>;
const nodeEnv = env.NODE_ENV;
beforeAll(async () => {
  env.NODE_ENV = "production";
  await jest.isolateModulesAsync(async () => {
    ({ GET, POST } = await import("@/app/api/trpc/[trpc]/route"));
  });
});
afterAll(() => {
  env.NODE_ENV = nodeEnv;
});
beforeEach(() => {
  jest.clearAllMocks();
  getToken.mockResolvedValue({ id: "user-1", email: "pat@example.com", role: "MANAGER" });
});

interface ErrorShape {
  message: string;
  data: { code: string; httpStatus: number };
}

/** One query through the HTTP route, as the screens' client sends it. */
async function query(path: string): Promise<{ status: number; text: string; error: ErrorShape }> {
  const res = await GET(new Request(`http://localhost/api/trpc/${path}`));
  const text = await res.text();
  return { status: res.status, text, error: JSON.parse(text).error.json };
}

describe("tRPC: an unexpected error's 500", () => {
  it("says only that the server failed, and logs the original", async () => {
    findFirst.mockRejectedValueOnce(PRISMA_FAILURE);

    const { status, text, error } = await query("account.me");

    expect(status).toBe(500);
    expect(error.message).toBe("Internal server error");
    expect(error.data).toMatchObject({ code: "INTERNAL_SERVER_ERROR", httpStatus: 500 });
    expect(text).not.toMatch(INTERNALS);
    expect(logError).toHaveBeenCalledWith(
      "tRPC query account.me failed",
      PRISMA_FAILURE,
      expect.objectContaining({ trpcCode: "INTERNAL_SERVER_ERROR" }),
    );
  });

  it.each(["probe.throwsString", "probe.throwsObject"])(
    "says the same for %s, a throw that is not an Error",
    async (path) => {
      const { status, text, error } = await query(path);
      expect(status).toBe(500);
      expect(error.message).toBe("Internal server error");
      expect(text).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|payrollSecret/);
    },
  );

  it("is answered per call in a batch, beside a deliberate refusal", async () => {
    findFirst.mockRejectedValueOnce(PRISMA_FAILURE);
    const res = await GET(
      new Request("http://localhost/api/trpc/account.me,probe.notFound?batch=1&input={}"),
    );
    const text = await res.text();
    const [me, notFound] = JSON.parse(text) as { error: { json: ErrorShape } }[];

    expect(me.error.json.message).toBe("Internal server error");
    expect(notFound.error.json.message).toBe("Billing is not enabled.");
    expect(text).not.toMatch(INTERNALS);
  });
});

describe("tRPC: a TRPCError thrown on purpose keeps its message", () => {
  it.each([
    ["probe.badRequest", 400, "Invalid due date."],
    ["probe.forbidden", 403, "Insufficient role."],
    ["probe.notFound", 404, "Billing is not enabled."],
    ["probe.conflict", 409, "A payment link is already open on this invoice."],
    ["probe.deliberate500", 500, "The invoice's journal did not post."],
  ])("%s answers %p with its own message", async (path, status, message) => {
    const answer = await query(path);
    expect(answer.status).toBe(status);
    expect(answer.error.message).toBe(message);
    expect(answer.text).not.toMatch(/deadlock/);
  });

  it("from the real account router: no staff record is a 404 that says so", async () => {
    findFirst.mockResolvedValueOnce(null);
    const { status, error } = await query("account.me");
    expect(status).toBe(404);
    expect(error.message).toBe("No staff record for this account.");
  });

  it("from the real builders: a request with no session is a 401 that says so", async () => {
    getToken.mockResolvedValueOnce(null);
    const { status, error } = await query("account.me");
    expect(status).toBe(401);
    expect(error.message).toBe("Sign-in required.");
  });

  it("from the real account router: input its schema refuses is a 400 that says why", async () => {
    const res = await POST(
      new Request("http://localhost/api/trpc/account.setTagPrintMode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { mode: "SIDEWAYS" } }),
      }),
    );
    const error: ErrorShape = JSON.parse(await res.text()).error.json;
    expect(res.status).toBe(400);
    expect(error.data.code).toBe("BAD_REQUEST");
    expect(error.message).toMatch(/mode/);
  });
});
