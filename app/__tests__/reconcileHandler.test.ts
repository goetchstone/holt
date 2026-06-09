// /app/__tests__/reconcileHandler.test.ts
//
// PLACEHOLDER TEST -- Grade: C+ (mocked-Prisma orchestration)
//
// What this verifies: the pure `handleReconcile` body wires the
// expected status codes (405 / 400 / 404 / 200 / 500), parses the id,
// loads the JE, calls `computeDailyReconciliation`, persists a
// DailyReconciliationLog row, and returns the result -- against mocks.
//
// What this DOES NOT verify: the actual auth wrapper behavior (the
// wrapper is bypassed by passing a fake session straight to the handler),
// the actual SQL behavior of findUnique / create, or the integration
// between findUnique returning a Decimal-typed journalDate and the
// computeDailyReconciliation contract.
//
// Upgrade target: Phase 0.6 -- replace with a supertest-style test that
// hits the wrapped handler against a real Postgres test DB. See plan
// "Phase 0.6 -- Test infrastructure roadmap".

import { handleReconcile } from "../src/pages/api/accounting/journal-entries/[id]/reconcile";

function makeReq(opts: { method?: string; query?: Record<string, string> } = {}) {
  return {
    method: opts.method ?? "POST",
    query: opts.query ?? { id: "42" },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeRes() {
  const res = {
    statusCode: 0 as number,
    headers: {} as Record<string, unknown>,
    body: undefined as unknown,
    ended: false as boolean,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    end(payload?: unknown) {
      this.body = payload;
      this.ended = true;
      return this;
    },
    setHeader(name: string, value: unknown) {
      this.headers[name] = value;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return res;
}

// Cast to any once at the top -- the handler only reads session.user.email,
// not the full Session shape. Saves repeating the cast at every call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeSession = { user: { email: "test@example.com" } } as any;

function makeMockPrisma(opts: {
  je?: { id: number; journalDate: Date; journalNumber: string; status: string } | null;
  lineItems?: { netPrice: number; vatAmount: number; cost: number }[];
  payments?: { paymentAmount: number }[];
  journalEntryForRecon?: {
    id: number;
    status: string;
    lines: { debit: number; credit: number; glAccount: { code: string } | null }[];
  } | null;
  createThrows?: Error;
}) {
  const findUnique = jest.fn().mockResolvedValue(opts.je ?? null);
  // The reconciliation function calls findFirst on journalEntry too -- need both.
  const findFirst = jest.fn().mockResolvedValue(opts.journalEntryForRecon ?? null);
  const create = jest.fn();
  if (opts.createThrows) {
    create.mockRejectedValue(opts.createThrows);
  } else {
    create.mockResolvedValue({ id: 1 });
  }
  return {
    journalEntry: { findUnique, findFirst },
    orderLineItem: { findMany: jest.fn().mockResolvedValue(opts.lineItems ?? []) },
    payment: { findMany: jest.fn().mockResolvedValue(opts.payments ?? []) },
    dailyReconciliationLog: { create },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("handleReconcile", () => {
  it("returns 405 when method is not POST", async () => {
    const req = makeReq({ method: "GET" });
    const res = makeRes();
    const client = makeMockPrisma({});
    await handleReconcile(req, res, fakeSession, client);
    expect(res.statusCode).toBe(405);
    expect(res.headers["Allow"]).toEqual(["POST"]);
  });

  it("returns 400 when id is not a number", async () => {
    const req = makeReq({ query: { id: "not-a-number" } });
    const res = makeRes();
    const client = makeMockPrisma({});
    await handleReconcile(req, res, fakeSession, client);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Invalid journal entry id" });
  });

  it("returns 404 when JE is not found", async () => {
    const req = makeReq();
    const res = makeRes();
    const client = makeMockPrisma({ je: null });
    await handleReconcile(req, res, fakeSession, client);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: "Journal entry not found" });
  });

  it("returns 200 with reconciliation result and persists a log row when JE is found", async () => {
    const req = makeReq();
    const res = makeRes();
    const client = makeMockPrisma({
      je: {
        id: 42,
        journalDate: new Date("2026-04-28T00:00:00Z"),
        journalNumber: "SJ20260428",
        status: "POSTED",
      },
      lineItems: [{ netPrice: 1000, vatAmount: 63.5, cost: 400 }],
      payments: [{ paymentAmount: 1063.5 }],
      journalEntryForRecon: {
        id: 42,
        status: "POSTED",
        lines: [
          { debit: 1063.5, credit: 0, glAccount: { code: "1-1006" } },
          { debit: 0, credit: 1000, glAccount: { code: "4-4080" } },
          { debit: 0, credit: 63.5, glAccount: { code: "2-2120" } },
          { debit: 400, credit: 0, glAccount: { code: "5-5280" } },
        ],
      },
    });
    await handleReconcile(req, res, fakeSession, client);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      hasJournalEntry: true,
      balanced: true,
    });
    expect(client.dailyReconciliationLog.create).toHaveBeenCalledTimes(1);
    const persisted = client.dailyReconciliationLog.create.mock.calls[0][0].data;
    expect(persisted.journalEntryId).toBe(42);
    expect(persisted.balanced).toBe(true);
    expect(persisted.createdBy).toBe("test@example.com");
    expect(typeof persisted.durationMs).toBe("number");
  });

  it("returns 500 when persistence throws", async () => {
    const req = makeReq();
    const res = makeRes();
    const client = makeMockPrisma({
      je: {
        id: 42,
        journalDate: new Date("2026-04-28T00:00:00Z"),
        journalNumber: "SJ20260428",
        status: "POSTED",
      },
      createThrows: new Error("DB write failed"),
    });
    await handleReconcile(req, res, fakeSession, client);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "DB write failed" });
  });

  it("falls back to a generic message when caught error is not an Error", async () => {
    const req = makeReq();
    const res = makeRes();
    const client = makeMockPrisma({
      je: {
        id: 42,
        journalDate: new Date("2026-04-28T00:00:00Z"),
        journalNumber: "SJ20260428",
        status: "POSTED",
      },
    });
    // Force a non-Error throw inside the persist step
    client.dailyReconciliationLog.create.mockRejectedValue("string error");
    await handleReconcile(req, res, fakeSession, client);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Reconciliation failed" });
  });

  it("handles a session with no email by storing null in createdBy", async () => {
    const req = makeReq();
    const res = makeRes();
    const sessionWithoutEmail = { user: {} };
    const client = makeMockPrisma({
      je: {
        id: 42,
        journalDate: new Date("2026-04-28T00:00:00Z"),
        journalNumber: "SJ20260428",
        status: "POSTED",
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleReconcile(req, res, sessionWithoutEmail as any, client);
    expect(res.statusCode).toBe(200);
    const persisted = client.dailyReconciliationLog.create.mock.calls[0][0].data;
    expect(persisted.createdBy).toBeNull();
  });
});
