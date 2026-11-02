// /app/__tests__/integration/serviceChecklists.integration.test.ts
//
// GAP-11: service checklists (owner, 2026-11-01: task checklists). The store
// sets up the steps a kind of service job takes in Settings > Service; staff
// give a case one, and each step becomes one of the case's tasks, due its days
// after today on the store's calendar.
//
// Real routes, real database; next-auth's session is the only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import type { Session } from "next-auth";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import { addDays, businessDayKey } from "@/lib/reports/businessDay";
import checklistsRoute from "@/pages/api/service/checklists/index";
import checklistRoute from "@/pages/api/service/checklists/[id]";
import applyRoute from "@/pages/api/service/cases/[id]/checklist";
import caseRoute from "@/pages/api/service/cases/[id]/index";
import caseTasksRoute from "@/pages/api/service/cases/[id]/tasks";

interface TestRes extends NextApiResponse {
  statusCode: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function makeRes(): TestRes {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    send(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end(payload?: unknown) {
      if (payload !== undefined) this.body = payload;
      return this;
    },
  };
  return res as unknown as TestRes;
}

async function call(
  route: (req: NextApiRequest, res: NextApiResponse) => unknown,
  method: string,
  query: Record<string, string> = {},
  body?: unknown,
) {
  const res = makeRes();
  const req = { method, query, body, cookies: {}, headers: {} } as unknown as NextApiRequest;
  await route(req, res);
  return res;
}

function sessionFor(id: string): Session {
  return { user: { id, email: `${id}@example.com` } } as unknown as Session;
}

async function staffAs(id: string, roleKey: string) {
  await prisma.user.create({ data: { id, email: `${id}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId: id,
      email: `${id}@example.com`,
      displayName: id,
      role: roleKey as never,
      roleId: role.id,
    },
  });
}

function signIn(id: string) {
  (getServerSession as jest.Mock).mockResolvedValue(sessionFor(id));
}

// A zone whose day differs from UTC's right now -- UTC+14 from 10:00 UTC on,
// UTC-11 before 11:00 -- so a due date counted from the UTC day fails the test.
const STORE_ZONE =
  businessDayKey(new Date(), "Pacific/Kiritimati") === businessDayKey(new Date(), "UTC")
    ? "Pacific/Pago_Pago"
    : "Pacific/Kiritimati";
const storeToday = () => businessDayKey(new Date(), STORE_ZONE);

async function serviceCase(n = 1) {
  const type = await prisma.serviceCaseType.upsert({
    where: { name: "Repair" },
    update: {},
    create: { name: "Repair" },
  });
  const status = await prisma.serviceCaseStatus.upsert({
    where: { name: "Open" },
    update: {},
    create: { name: "Open" },
  });
  const priority = await prisma.serviceCasePriority.upsert({
    where: { name: "Normal" },
    update: {},
    create: { name: "Normal" },
  });
  return prisma.serviceCase.create({
    data: {
      caseNumber: `SC-${n}`,
      summary: "Recliner won't close",
      typeId: type.id,
      statusId: status.id,
      priorityId: priority.id,
    },
  });
}

const RECLINER = {
  name: "  Recliner mechanism repair ",
  steps: [
    { title: " Photograph the mechanism ", description: " Serial label too ", dueAfterDays: 0 },
    { title: "Order the part", description: null, dueAfterDays: 2 },
    { title: "Book the technician", dueAfterDays: null },
  ],
};

async function addChecklist(body: unknown = RECLINER) {
  const res = await call(checklistsRoute, "POST", {}, body);
  expect(res.statusCode).toBe(201);
  return res.body as { id: number; name: string };
}

const apply = (caseId: number, checklistId: unknown) =>
  call(applyRoute, "POST", { id: String(caseId) }, { checklistId });

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: STORE_ZONE },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  await staffAs("owner", "ADMIN");
  signIn("owner");
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Settings › Service › Checklists", () => {
  it("adds a checklist with its steps in order, trimmed", async () => {
    await addChecklist();
    const all = await call(checklistsRoute, "GET", { all: "1" });
    expect(all.body).toEqual([
      {
        id: expect.any(Number),
        name: "Recliner mechanism repair",
        isActive: true,
        sortOrder: 0,
        steps: [
          { title: "Photograph the mechanism", description: "Serial label too", dueAfterDays: 0 },
          { title: "Order the part", description: null, dueAfterDays: 2 },
          { title: "Book the technician", description: null, dueAfterDays: null },
        ],
      },
    ]);
    const positions = await prisma.serviceChecklistStep.findMany({
      orderBy: { position: "asc" },
      select: { position: true, title: true },
    });
    expect(positions.map((p) => p.position)).toEqual([0, 1, 2]);
  });

  it.each([
    ["no name", { ...RECLINER, name: " " }, /name/],
    ["no steps", { ...RECLINER, steps: [] }, /at least one step/],
    ["steps not a list", { ...RECLINER, steps: "Order the part" }, /at least one step/],
    ["a step with no title", { ...RECLINER, steps: [{ title: " " }] }, /Step 1 needs a title/],
    ["a negative due day", { ...RECLINER, steps: [{ title: "A", dueAfterDays: -1 }] }, /0 to 365/],
    ["over a year", { ...RECLINER, steps: [{ title: "A", dueAfterDays: 366 }] }, /0 to 365/],
    ["half a day", { ...RECLINER, steps: [{ title: "A", dueAfterDays: 1.5 }] }, /0 to 365/],
    ["due days as text", { ...RECLINER, steps: [{ title: "A", dueAfterDays: "2" }] }, /0 to 365/],
    [
      "31 steps",
      { ...RECLINER, steps: Array.from({ length: 31 }, (_, i) => ({ title: `Step ${i}` })) },
      /at most 30 steps/,
    ],
  ])("refuses %s, saying why", async (_label, body, message) => {
    const res = await call(checklistsRoute, "POST", {}, body);
    expect([res.statusCode, res.body.error]).toEqual([400, expect.stringMatching(message)]);
    expect(await prisma.serviceChecklist.count()).toBe(0);
  });

  it("refuses a second checklist with the same name, whatever its case", async () => {
    await addChecklist();
    const res = await call(
      checklistsRoute,
      "POST",
      {},
      { ...RECLINER, name: "RECLINER mechanism repair" },
    );
    expect([res.statusCode, res.body.error]).toEqual([409, expect.stringMatching(/already/)]);
  });

  it("renames it and swaps its steps for the ones sent, in the order sent", async () => {
    const { id } = await addChecklist();
    const res = await call(
      checklistRoute,
      "PUT",
      { id: String(id) },
      {
        name: "Recliner repair",
        steps: [
          { title: "Book the technician", dueAfterDays: 5 },
          { title: "Order the part", dueAfterDays: 1 },
        ],
      },
    );
    expect(res.statusCode).toBe(200);
    const [row] = (await call(checklistsRoute, "GET", { all: "1" })).body;
    expect(row.name).toBe("Recliner repair");
    expect(row.steps).toEqual([
      { title: "Book the technician", description: null, dueAfterDays: 5 },
      { title: "Order the part", description: null, dueAfterDays: 1 },
    ]);
    expect(await prisma.serviceChecklistStep.count()).toBe(2);
  });

  it("leaves the steps alone when none are sent, and refuses an empty list", async () => {
    const { id } = await addChecklist();
    const reordered = await call(checklistRoute, "PUT", { id: String(id) }, { sortOrder: 4 });
    expect(reordered.statusCode).toBe(200);
    expect(await prisma.serviceChecklistStep.count()).toBe(3);
    const empty = await call(checklistRoute, "PUT", { id: String(id) }, { steps: [] });
    expect(empty.statusCode).toBe(400);
    expect(await prisma.serviceChecklistStep.count()).toBe(3);
  });

  it("a switched-off checklist is listed in Settings but not offered on a case", async () => {
    const { id } = await addChecklist();
    await addChecklist({ name: "Delivery damage", steps: [{ title: "Collect photos" }] });
    await call(checklistRoute, "PUT", { id: String(id) }, { isActive: false });
    expect((await call(checklistsRoute, "GET")).body).toEqual([
      { id: expect.any(Number), name: "Delivery damage", stepCount: 1 },
    ]);
    expect((await call(checklistsRoute, "GET", { all: "1" })).body).toHaveLength(2);
  });

  it("deletes a checklist and its steps; an unknown one is 404", async () => {
    const { id } = await addChecklist();
    const res = await call(checklistRoute, "DELETE", { id: String(id) });
    expect(res.statusCode).toBe(200);
    expect(await prisma.serviceChecklist.count()).toBe(0);
    expect(await prisma.serviceChecklistStep.count()).toBe(0);
    expect((await call(checklistRoute, "DELETE", { id: String(id) })).statusCode).toBe(404);
    expect((await call(checklistRoute, "PUT", { id: String(id) }, { name: "X" })).statusCode).toBe(
      404,
    );
  });
});

describe("giving a case a checklist", () => {
  it("adds one task per step, in step order, due on the store's calendar", async () => {
    const c = await serviceCase();
    const { id } = await addChecklist();
    const res = await apply(c.id, id);
    expect([res.statusCode, res.body]).toEqual([
      201,
      { name: "Recliner mechanism repair", created: 3 },
    ]);

    const today = storeToday();
    const tasks = (await call(caseTasksRoute, "GET", { id: String(c.id) })).body;
    expect(
      tasks.map((t: { title: string; description: string | null; dueDate: Date | null }) => [
        t.title,
        t.description,
        t.dueDate && new Date(t.dueDate).toISOString(),
      ]),
    ).toEqual([
      ["Photograph the mechanism", "Serial label too", `${today}T00:00:00.000Z`],
      ["Order the part", null, `${addDays(today, 2)}T00:00:00.000Z`],
      ["Book the technician", null, null],
    ]);
    expect(tasks.every((t: { status: string }) => t.status === "PENDING")).toBe(true);

    // The case page reads them in the same order.
    const page = await call(caseRoute, "GET", { id: String(c.id) });
    expect(page.body.tasks.map((t: { title: string }) => t.title)).toEqual([
      "Photograph the mechanism",
      "Order the part",
      "Book the technician",
    ]);
  });

  it("won't give a case the same checklist twice", async () => {
    const c = await serviceCase();
    const { id } = await addChecklist();
    await apply(c.id, id);
    const again = await apply(c.id, id);
    expect([again.statusCode, again.body.error]).toEqual([
      409,
      expect.stringMatching(/already has the "Recliner mechanism repair" tasks/),
    ]);
    expect(await prisma.serviceTask.count()).toBe(3);

    // Another case may have it.
    const other = await serviceCase(2);
    expect((await apply(other.id, id)).statusCode).toBe(201);
  });

  it.each([
    {
      label: "a switched-off checklist",
      status: 409,
      message: /switched off/,
      send: async (caseId: number, id: number) => {
        await call(checklistRoute, "PUT", { id: String(id) }, { isActive: false });
        return apply(caseId, id);
      },
    },
    {
      label: "an unknown checklist",
      status: 404,
      message: /Checklist not found/,
      send: (caseId: number, id: number) => apply(caseId, id + 1000),
    },
    {
      label: "an unknown case",
      status: 404,
      message: /case not found/,
      send: (caseId: number, id: number) => apply(caseId + 1000, id),
    },
    {
      label: "a checklist id that isn't one",
      status: 400,
      message: /checklistId/,
      send: (caseId: number, id: number) => apply(caseId, String(id)),
    },
  ])("refuses $label, saying why", async ({ status, message, send }) => {
    const c = await serviceCase();
    const { id } = await addChecklist();
    const res = await send(c.id, id);
    expect([res.statusCode, res.body.error]).toEqual([status, expect.stringMatching(message)]);
    expect(await prisma.serviceTask.count()).toBe(0);
  });

  it("refuses a checklist with no steps -- one written straight to the database", async () => {
    const c = await serviceCase();
    const empty = await prisma.serviceChecklist.create({ data: { name: "Empty" } });
    const res = await apply(c.id, empty.id);
    expect([res.statusCode, res.body.error]).toEqual([409, expect.stringMatching(/has no steps/)]);
  });

  it("copies the steps: changing or deleting the checklist leaves the case's tasks be", async () => {
    const c = await serviceCase();
    const { id } = await addChecklist();
    await apply(c.id, id);
    await call(checklistRoute, "PUT", { id: String(id) }, { steps: [{ title: "Something else" }] });
    let titles = (await prisma.serviceTask.findMany({ orderBy: { id: "asc" } })).map(
      (t) => t.title,
    );
    expect(titles).toEqual(["Photograph the mechanism", "Order the part", "Book the technician"]);

    await call(checklistRoute, "DELETE", { id: String(id) });
    const kept = await prisma.serviceTask.findMany({ orderBy: { id: "asc" } });
    titles = kept.map((t) => t.title);
    expect(titles).toEqual(["Photograph the mechanism", "Order the part", "Book the technician"]);
    expect(kept.every((t) => t.checklistId === null)).toBe(true);
  });
});

describe("who may do what", () => {
  it("anyone who works service cases picks and applies; only configuration sets them up", async () => {
    const c = await serviceCase();
    const { id } = await addChecklist();
    await staffAs("tech", "WAREHOUSE");
    signIn("tech");

    expect((await call(checklistsRoute, "GET")).body).toEqual([
      { id, name: "Recliner mechanism repair", stepCount: 3 },
    ]);
    expect((await apply(c.id, id)).statusCode).toBe(201);

    expect((await call(checklistsRoute, "GET", { all: "1" })).statusCode).toBe(403);
    expect((await call(checklistsRoute, "POST", {}, RECLINER)).statusCode).toBe(403);
    expect((await call(checklistRoute, "PUT", { id: String(id) }, { name: "X" })).statusCode).toBe(
      403,
    );
    expect((await call(checklistRoute, "DELETE", { id: String(id) })).statusCode).toBe(403);
  });

  it("the register can't give a case a checklist", async () => {
    const c = await serviceCase();
    const { id } = await addChecklist();
    await staffAs("till", "REGISTER");
    signIn("till");
    expect((await apply(c.id, id)).statusCode).toBe(403);
    expect((await call(checklistsRoute, "GET")).statusCode).toBe(403);
    expect(await prisma.serviceTask.count()).toBe(0);
  });
});

describe("the database", () => {
  it("refuses a step due before it's applied or more than a year after", async () => {
    const checklist = await prisma.serviceChecklist.create({ data: { name: "Raw" } });
    for (const dueAfterDays of [-1, 366]) {
      await expect(
        prisma.serviceChecklistStep.create({
          data: { checklistId: checklist.id, position: 0, title: "A", dueAfterDays },
        }),
      ).rejects.toThrow(/dueAfterDays_range/);
    }
    await expect(
      prisma.serviceChecklistStep.create({
        data: { checklistId: checklist.id, position: -1, title: "A" },
      }),
    ).rejects.toThrow(/position_nonnegative/);
  });
});
