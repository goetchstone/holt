// /app/__tests__/integration/tillVarianceEnforcement.integration.test.ts
//
// Real-DB integration coverage for the Phase 0.6 till variance discipline
// (docs/domains/pos.md): mandatory note > $5, escalation + register block
// > $100, and the block/clear cycle at the register-open boundary. The
// pure threshold math is unit-tested exhaustively in
// __tests__/tillVariance.test.ts -- this file proves the ROUTE HANDLERS
// actually enforce it against Postgres (transaction atomicity, Decimal
// round-tripping, the Register.blockedAt gate on
// pages/api/registers/[id]/tills/open.ts). Calls the exported handleX
// functions directly against the real `prisma` client (same pattern as
// pages/api/accounting/journal-entries/[id]/reconcile.ts's
// handleReconcile) with a fake req/res pair -- this bypasses
// getServerSession/requireAuthWithRole (which need real cookies), so role
// enforcement itself stays covered by __tests__/roleDecision.test.ts.
//
// Till reconciliation previously had "no real-DB equivalent" per
// docs/domains/pos.md's test-coverage table.

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { handleClose } from "@/pages/api/tills/[id]/close";
import { handleReconcile } from "@/pages/api/tills/[id]/reconcile";
import { handleOpenTill } from "@/pages/api/registers/[id]/tills/open";
import { handleUnblock } from "@/pages/api/registers/[id]/unblock";

function makeReq(opts: {
  method?: string;
  query?: Record<string, string>;
  body?: unknown;
}): NextApiRequest {
  return {
    method: opts.method ?? "POST",
    query: opts.query ?? {},
    body: opts.body ?? {},
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
  } as any as NextApiResponse & {
    statusCode: number;
    body: unknown;
  };
  return res;
}

async function fixtures() {
  const store = await prisma.storeLocation.create({
    data: { name: `Main-${Date.now()}`, code: `MAIN-${Date.now()}`, type: "STORE" },
  });
  const register = await prisma.register.create({
    data: { name: "Front Desk", storeLocationId: store.id },
  });
  const cashier = await prisma.staffMember.create({
    data: { displayName: "Cashier Cass", email: "cashier@example.com", role: "REGISTER" },
  });
  const manager = await prisma.staffMember.create({
    data: { displayName: "Manager Max", email: "manager@example.com", role: "MANAGER" },
  });
  const till = await prisma.till.create({
    data: {
      registerId: register.id,
      status: "OPEN",
      openedById: cashier.id,
      openingCash: 200,
    },
  });
  return { store, register, cashier, manager, till };
}

const cashierSession = { user: { email: "cashier@example.com" } } as unknown as Session;
const managerSession = { user: { email: "manager@example.com" } } as unknown as Session;

describe("Till variance discipline — real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // ── close.ts: mandatory note ────────────────────────────────────────

  it("close.ts rejects a >$5 variance close with no note, and does NOT close the till", async () => {
    const { till } = await fixtures();
    const req = makeReq({ query: { id: String(till.id) }, body: { actualCash: 210 } }); // +$10 vs $200 opening
    const res = makeRes();

    await handleClose(req, res, cashierSession, prisma);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/\$10\.00/);
    expect((res.body as { error: string }).error).toMatch(/note/i);

    const stillOpen = await prisma.till.findUniqueOrThrow({ where: { id: till.id } });
    expect(stillOpen.status).toBe("OPEN");
  });

  it("close.ts allows a >$5 variance close WITH a note", async () => {
    const { till } = await fixtures();
    const req = makeReq({
      query: { id: String(till.id) },
      body: { actualCash: 210, notes: "counted twice, till was over" },
    });
    const res = makeRes();

    await handleClose(req, res, cashierSession, prisma);

    expect(res.statusCode).toBe(200);
    const body = res.body as { status: string; variance: number; varianceClassification: unknown };
    expect(body.status).toBe("CLOSED");
    expect(body.variance).toBe(10);
    expect(body.varianceClassification).toEqual({
      level: "NOTE",
      requiresNote: true,
      requiresManager: false,
      blocksRegister: false,
    });
  });

  it("close.ts allows a <=$5 variance close with NO note required", async () => {
    const { till } = await fixtures();
    const req = makeReq({ query: { id: String(till.id) }, body: { actualCash: 203 } }); // +$3
    const res = makeRes();

    await handleClose(req, res, cashierSession, prisma);

    expect(res.statusCode).toBe(200);
    const closed = await prisma.till.findUniqueOrThrow({ where: { id: till.id } });
    expect(closed.status).toBe("CLOSED");
    expect(Number(closed.variance)).toBe(3);
  });

  // ── close.ts: escalation blocks the register ────────────────────────

  it("close.ts with a >$100 variance escalates: blocks the register, and open.ts then refuses a new till", async () => {
    const { till, register } = await fixtures();
    const closeReq = makeReq({
      query: { id: String(till.id) },
      body: { actualCash: 350, notes: "large overage, investigating" }, // +$150 vs $200 opening
    });
    const closeRes = makeRes();

    await handleClose(closeReq, closeRes, cashierSession, prisma);

    expect(closeRes.statusCode).toBe(200);
    const blockedRegister = await prisma.register.findUniqueOrThrow({ where: { id: register.id } });
    expect(blockedRegister.blockedAt).not.toBeNull();
    expect(blockedRegister.blockReason).toContain(`Till #${till.id}`);
    expect(blockedRegister.blockReason).toContain("$150.00");

    // A new till open on this register must now be refused.
    const openReq = makeReq({ query: { id: String(register.id) }, body: { openingCash: 200 } });
    const openRes = makeRes();
    await handleOpenTill(openReq, openRes, cashierSession, prisma);

    expect(openRes.statusCode).toBe(409);
    expect((openRes.body as { error: string }).error).toMatch(/blocked/i);

    const tillCount = await prisma.till.count({ where: { registerId: register.id } });
    expect(tillCount).toBe(1); // only the original till -- no new one was created
  });

  it("a shortage of the same magnitude (-$150) escalates identically to an overage", async () => {
    const { till, register } = await fixtures();
    const req = makeReq({
      query: { id: String(till.id) },
      body: { actualCash: 50, notes: "drawer short, escalating" }, // -$150 vs $200 opening
    });
    const res = makeRes();

    await handleClose(req, res, cashierSession, prisma);

    expect(res.statusCode).toBe(200);
    const blockedRegister = await prisma.register.findUniqueOrThrow({ where: { id: register.id } });
    expect(blockedRegister.blockedAt).not.toBeNull();
    expect(blockedRegister.blockReason).toContain("shortage");
  });

  // ── unblock.ts: clears the block, open.ts then succeeds ─────────────

  it("unblock.ts requires a resolutionNote and refuses to clear without one", async () => {
    const { till, register, manager } = await fixtures();
    await handleClose(
      makeReq({ query: { id: String(till.id) }, body: { actualCash: 350, notes: "over" } }),
      makeRes(),
      cashierSession,
      prisma,
    );
    void manager;

    const req = makeReq({ query: { id: String(register.id) }, body: {} });
    const res = makeRes();
    await handleUnblock(req, res, managerSession, prisma);

    expect(res.statusCode).toBe(400);
    const stillBlocked = await prisma.register.findUniqueOrThrow({ where: { id: register.id } });
    expect(stillBlocked.blockedAt).not.toBeNull();
  });

  it("unblock.ts clears the block with a resolutionNote, and open.ts then succeeds", async () => {
    const { till, register } = await fixtures();
    await handleClose(
      makeReq({ query: { id: String(till.id) }, body: { actualCash: 350, notes: "over" } }),
      makeRes(),
      cashierSession,
      prisma,
    );

    const unblockReq = makeReq({
      query: { id: String(register.id) },
      body: { resolutionNote: "recounted, found a misplaced $150 stack from the prior shift" },
    });
    const unblockRes = makeRes();
    await handleUnblock(unblockReq, unblockRes, managerSession, prisma);

    expect(unblockRes.statusCode).toBe(200);
    const cleared = await prisma.register.findUniqueOrThrow({ where: { id: register.id } });
    expect(cleared.blockedAt).toBeNull();
    // History survives in blockReason even though the block itself is cleared.
    expect(cleared.blockReason).toContain(`Till #${till.id}`);
    expect(cleared.blockReason).toContain("Cleared by manager@example.com");
    expect(cleared.blockReason).toContain("misplaced $150 stack");

    const openReq = makeReq({ query: { id: String(register.id) }, body: { openingCash: 200 } });
    const openRes = makeRes();
    await handleOpenTill(openReq, openRes, cashierSession, prisma);

    expect(openRes.statusCode).toBe(201);
    const tillCount = await prisma.till.count({ where: { registerId: register.id } });
    expect(tillCount).toBe(2);
  });

  // ── reconcile.ts: defense-in-depth ───────────────────────────────────

  it("reconcile.ts rejects an un-noted CLOSED till above $5 (defense-in-depth for a till that bypassed close.ts's check)", async () => {
    const { till } = await fixtures();
    // Simulate a till that reached CLOSED without a note some other way
    // (e.g. a legacy row) -- write it directly rather than through
    // close.ts, which would have rejected it.
    await prisma.till.update({
      where: { id: till.id },
      data: { status: "CLOSED", expectedCash: 200, actualCash: 210, variance: 10, notes: null },
    });

    const req = makeReq({ query: { id: String(till.id) }, body: {} });
    const res = makeRes();
    await handleReconcile(req, res, managerSession, prisma);

    expect(res.statusCode).toBe(400);
    const stillClosed = await prisma.till.findUniqueOrThrow({ where: { id: till.id } });
    expect(stillClosed.status).toBe("CLOSED");
  });

  it("reconcile.ts accepts a supplied note at reconcile time and appends it to the till", async () => {
    const { till } = await fixtures();
    await prisma.till.update({
      where: { id: till.id },
      data: { status: "CLOSED", expectedCash: 200, actualCash: 210, variance: 10, notes: null },
    });

    const req = makeReq({
      query: { id: String(till.id) },
      body: { notes: "manager confirmed: register short-rang a discount" },
    });
    const res = makeRes();
    await handleReconcile(req, res, managerSession, prisma);

    expect(res.statusCode).toBe(200);
    const reconciled = await prisma.till.findUniqueOrThrow({ where: { id: till.id } });
    expect(reconciled.status).toBe("RECONCILED");
    expect(reconciled.notes).toContain("manager confirmed");
  });

  it("reconcile.ts re-affirms the register block for an escalation-tier till that reached CLOSED without going through close.ts", async () => {
    const { till, register } = await fixtures();
    await prisma.till.update({
      where: { id: till.id },
      data: {
        status: "CLOSED",
        expectedCash: 200,
        actualCash: 400,
        variance: 200,
        notes: "big overage",
      },
    });
    const unblockedRegister = await prisma.register.findUniqueOrThrow({
      where: { id: register.id },
    });
    expect(unblockedRegister.blockedAt).toBeNull(); // not blocked yet -- close.ts never ran

    const req = makeReq({ query: { id: String(till.id) }, body: {} });
    const res = makeRes();
    await handleReconcile(req, res, managerSession, prisma);

    expect(res.statusCode).toBe(200);
    const nowBlocked = await prisma.register.findUniqueOrThrow({ where: { id: register.id } });
    expect(nowBlocked.blockedAt).not.toBeNull();
    expect(nowBlocked.blockReason).toContain(`Till #${till.id}`);
  });
});
