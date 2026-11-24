// /app/__tests__/integration/serviceRouteKeys.integration.test.ts
//
// Who each service route admits, now that its role list is a permission key
// (2026-11-21). An assertion whose answer changed is marked with what the
// route answered before ("was 403"). What changed:
//   - The Owner opens a case, adds a case task and reschedules an appointment.
//     Those checks compared the raw staff enum with lists naming ADMIN, so
//     SUPER_ADMIN never matched.
//   - Register and Marketing no longer read the case queue or a case's tasks.
//     No screen of theirs calls those routes, and the case's other routes
//     already refused them.
//   - Roles holding View service read the case type, status and priority lists
//     their screens need. Only Managers and Administrators could.
//   - Dispatch reschedules appointments and reads the installer picker.
//   - A store's own role follows its grants, not the DESIGNER enum its staff
//     carry.
// What did not change is pinned, so a later move onto Work service cannot
// widen it: service setup (zones and their fees, installers, case settings,
// email templates) stays with the Owner, Administrators and Managers, and the
// bookable-services catalog with the Owner and Administrators. The setup
// routes ask for Set up service itself, which only a role built in Roles can
// show: Managers hold several keys nobody else below the Administrator does.
//
// A route that sends GET to one gate and every other method to another ends on
// the second (`return writeGate(req, res)`). apiRouteAuthorization.test.ts
// checks that line is a gate; only a refusal here shows it is the right one, so
// each such route is refused a write by a role that passes its read gate.
//
// Real routes, real permission gate, real database; next-auth's session is the
// only mock.

jest.mock("next-auth", () => ({
  __esModule: true,
  default: jest.fn(),
  getServerSession: jest.fn(),
}));

import type { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { DEFAULT_ORG_ID, invalidateAppSettingsCache } from "@/lib/appSettings";
import { syncBuiltInRoles } from "@/lib/auth/builtInRoles";
import { permissionsForBuiltInRole, stripBaselinePermissions } from "@/lib/auth/permissionCatalog";
import { invalidateRoleGrantCache } from "@/lib/auth/permissionResolver";
import casesRoute from "@/pages/api/service/cases/index";
import caseTasksRoute from "@/pages/api/service/cases/[id]/tasks";
import typesRoute from "@/pages/api/service/settings/types";
import typeRoute from "@/pages/api/service/settings/types/[id]";
import statusesRoute from "@/pages/api/service/settings/statuses";
import statusRoute from "@/pages/api/service/settings/statuses/[id]";
import prioritiesRoute from "@/pages/api/service/settings/priorities";
import priorityRoute from "@/pages/api/service/settings/priorities/[id]";
import appointmentsRoute from "@/pages/api/service/dispatch/index";
import appointmentRoute from "@/pages/api/service/dispatch/[id]";
import installersRoute from "@/pages/api/service/installers/index";
import installerRoute from "@/pages/api/service/installers/[id]";
import zonesRoute from "@/pages/api/service/delivery-zones/index";
import zoneRoute from "@/pages/api/service/delivery-zones/[id]";
import zoneZipsRoute from "@/pages/api/service/delivery-zones/[id]/zips";
import templatesRoute from "@/pages/api/service/email-templates/index";
import templateRoute from "@/pages/api/service/email-templates/[id]";
import bookableServicesRoute from "@/pages/api/services/index";

const sessionMock = getServerSession as jest.Mock;

type Route = (req: NextApiRequest, res: NextApiResponse) => unknown;

interface TestRes {
  statusCode: number;
  body: unknown;
}

async function call(
  route: Route,
  method: string,
  query: Record<string, string> = {},
  body: unknown = {},
): Promise<TestRes> {
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
    setHeader() {
      return this;
    },
    end(payload?: unknown) {
      if (payload !== undefined) this.body = payload;
      return this;
    },
  };
  const req = { method, query, body, cookies: {}, headers: {} };
  await route(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return res;
}

const status = async (...args: Parameters<typeof call>) => (await call(...args)).statusCode;

/** A signed-in staff member on a built-in role (enum and roleId agree). */
async function makeStaff(userId: string, roleKey: string) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey } });
  await prisma.staffMember.create({
    data: {
      userId,
      email: `${userId}@example.com`,
      displayName: userId,
      role: roleKey as never,
      roleId: role.id,
    },
  });
}

/** A staff member on a role the store built in Roles. Its staff carry the
 *  enum DESIGNER, which every role list naming DESIGNER let through. */
async function makeCustomRoleStaff(userId: string, permissions: string[]) {
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  const role = await prisma.role.create({
    data: {
      key: `CUSTOM_${userId.toUpperCase()}`,
      name: `Custom ${userId}`,
      isSystem: false,
      permissions: { create: permissions.map((permission) => ({ permission })) },
    },
  });
  await prisma.staffMember.create({
    data: { userId, displayName: userId, role: "DESIGNER", roleId: role.id },
  });
  invalidateRoleGrantCache();
}

function signInAs(userId: string) {
  sessionMock.mockResolvedValue({ user: { id: userId, email: `${userId}@example.com` } });
}

let lookups: { typeId: number; statusId: number; priorityId: number };
let caseId: string;
let appointmentId: string;

const newCase = () => ({ ...lookups, summary: "Recliner won't close" });

beforeEach(async () => {
  await resetTestDb();
  invalidateRoleGrantCache();
  sessionMock.mockReset();
  await prisma.organization.create({
    data: { id: DEFAULT_ORG_ID, name: "Test Org", slug: "test-org" },
  });
  await prisma.appSettings.create({
    data: { organizationId: DEFAULT_ORG_ID, orderNumberPrefix: "TST", timezone: "UTC" },
  });
  invalidateAppSettingsCache();
  await syncBuiltInRoles({ prisma });
  // A privileged staff member exists, so the bootstrap safeguard is off.
  await makeStaff("admin", "ADMIN");

  const type = await prisma.serviceCaseType.create({ data: { name: "Repair" } });
  const caseStatus = await prisma.serviceCaseStatus.create({ data: { name: "Open" } });
  const priority = await prisma.serviceCasePriority.create({ data: { name: "Normal" } });
  lookups = { typeId: type.id, statusId: caseStatus.id, priorityId: priority.id };
  const serviceCase = await prisma.serviceCase.create({
    data: { caseNumber: "SC-1", summary: "Sofa leg cracked", ...lookups },
  });
  caseId = String(serviceCase.id);

  const order = await prisma.salesOrder.create({ data: { orderno: "SO-1", status: "ORDER" } });
  const appointment = await prisma.serviceAppointment.create({
    data: { appointmentNumber: "APT-1", salesOrderId: order.id, type: "INSTALL" },
  });
  appointmentId = String(appointment.id);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("service cases", () => {
  it("the Owner opens a case and adds a task to it", async () => {
    await makeStaff("owner", "SUPER_ADMIN");
    signInAs("owner");

    expect(await status(casesRoute, "POST", {}, newCase())).toBe(201); // was 403
    expect(await status(caseTasksRoute, "POST", { id: caseId }, { title: "Order the part" })).toBe(
      201,
    ); // was 403
  });

  it("Register and Marketing read neither the case queue nor a case's tasks", async () => {
    await makeStaff("till", "REGISTER");
    await makeStaff("promo", "MARKETING");

    for (const userId of ["till", "promo"]) {
      signInAs(userId);
      expect(await status(casesRoute, "GET")).toBe(403); // was 200
      expect(await status(caseTasksRoute, "GET", { id: caseId })).toBe(403); // was 200
      expect(await status(casesRoute, "POST", {}, newCase())).toBe(403);
    }
  });

  it("Customer Service, whose job is cases, works the queue", async () => {
    await makeStaff("cara", "CUSTOMER_SERVICE");
    signInAs("cara");

    const queue = await call(casesRoute, "GET");
    expect(queue.statusCode).toBe(200); // was 403
    expect((queue.body as { total: number }).total).toBe(1);
    expect(await status(casesRoute, "POST", {}, newCase())).toBe(201); // was 403
    expect(
      await status(caseTasksRoute, "POST", { id: caseId }, { title: "Call the customer" }),
    ).toBe(201); // was 403
  });

  it("a store's own role follows its grants, not the DESIGNER enum its staff carry", async () => {
    await makeCustomRoleStaff("floor", ["customer.read"]);
    await makeCustomRoleStaff("desk", ["service.read", "service.write"]);

    signInAs("floor");
    expect(await status(casesRoute, "POST", {}, newCase())).toBe(403); // was 201
    expect(await status(casesRoute, "GET")).toBe(403); // was 200

    signInAs("desk");
    expect(await status(casesRoute, "GET")).toBe(200);
    expect(await status(casesRoute, "POST", {}, newCase())).toBe(201);
  });

  it("View service alone reads the queue and writes nothing to it", async () => {
    // Every built-in role holding View service also holds Work service, so only
    // a role built in Roles shows that the queue's last line, which takes every
    // method but GET, asks for Work service.
    await makeCustomRoleStaff("viewer", ["service.read"]);
    signInAs("viewer");

    expect(await status(casesRoute, "GET")).toBe(200);
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect({ method, status: await status(casesRoute, method, {}, newCase()) }).toEqual({
        method,
        status: 403,
      });
    }
    expect(await prisma.serviceCase.count()).toBe(1);
  });
});

describe("case types, statuses and priorities", () => {
  it("anyone holding View service reads the lists; changing them is setup", async () => {
    await makeStaff("dee", "DESIGNER");
    signInAs("dee");

    expect(await status(typesRoute, "GET")).toBe(200); // was 403
    expect(await status(statusesRoute, "GET")).toBe(200); // was 403
    expect(await status(prioritiesRoute, "GET")).toBe(200); // was 403
    expect(await status(typesRoute, "POST", {}, { name: "Warranty" })).toBe(403);
    expect(
      await status(typeRoute, "PUT", { id: String(lookups.typeId) }, { name: "Repairs" }),
    ).toBe(403);
  });

  it("View service is refused every write to the lists, by any method", async () => {
    // Each list sends GET to its read gate and every other method to its setup
    // gate on its last line. A Designer passes the read gate, so a write it is
    // refused could only have been refused by the setup gate.
    await makeStaff("dee", "DESIGNER");
    signInAs("dee");

    const lists: Array<[string, Route]> = [
      ["types", typesRoute],
      ["statuses", statusesRoute],
      ["priorities", prioritiesRoute],
    ];
    for (const [list, route] of lists) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        expect({
          list,
          method,
          status: await status(route, method, {}, { name: "Urgent" }),
        }).toEqual({ list, method, status: 403 });
      }
    }
    // The single-row routes behind them are setup for every method.
    const rows: Array<[string, Route, number]> = [
      ["statuses/[id]", statusRoute, lookups.statusId],
      ["priorities/[id]", priorityRoute, lookups.priorityId],
    ];
    for (const [row, route, id] of rows) {
      for (const method of ["PUT", "DELETE"]) {
        expect({
          row,
          method,
          status: await status(route, method, { id: String(id) }, { name: "Urgent" }),
        }).toEqual({ row, method, status: 403 });
      }
    }

    expect(await prisma.serviceCaseType.count()).toBe(1);
    expect(await prisma.serviceCaseStatus.findMany({ select: { name: true } })).toEqual([
      { name: "Open" },
    ]);
    expect(await prisma.serviceCasePriority.findMany({ select: { name: true } })).toEqual([
      { name: "Normal" },
    ]);
  });

  it("Managers keep setting them up, as their role list let them", async () => {
    await makeStaff("mia", "MANAGER");
    signInAs("mia");

    expect(await status(typesRoute, "POST", {}, { name: "Warranty" })).toBe(201);
    expect(
      await status(typeRoute, "PUT", { id: String(lookups.typeId) }, { name: "Repairs" }),
    ).toBe(200);
    expect(await status(statusesRoute, "POST", {}, { name: "Waiting on vendor" })).toBe(201);
    expect(await status(prioritiesRoute, "POST", {}, { name: "High" })).toBe(201);
  });

  it("Register, holding no service key, reads none of them", async () => {
    await makeStaff("till", "REGISTER");
    signInAs("till");

    expect(await status(typesRoute, "GET")).toBe(403);
    expect(await status(statusesRoute, "GET")).toBe(403);
    expect(await status(prioritiesRoute, "GET")).toBe(403);
  });
});

describe("the Service dispatch board", () => {
  const reschedule = { scheduledTime: "09:00" };

  it("rescheduling an appointment takes Operate warehouse", async () => {
    await makeStaff("owner", "SUPER_ADMIN");
    await makeStaff("dee", "DESIGNER");
    await makeStaff("wes", "WAREHOUSE");
    await makeStaff("dan", "DISPATCH");

    signInAs("dee");
    expect(await status(appointmentRoute, "GET", { id: appointmentId })).toBe(200);
    expect(await status(appointmentRoute, "PUT", { id: appointmentId }, reschedule)).toBe(403);

    // Dispatch and the Owner were 403: the old check compared the raw staff enum
    // with a list of WAREHOUSE, MANAGER, ADMIN and INSTALLER.
    for (const userId of ["wes", "dan", "owner"]) {
      signInAs(userId);
      expect(await status(appointmentRoute, "PUT", { id: appointmentId }, reschedule)).toBe(200);
    }

    const saved = await prisma.serviceAppointment.findUniqueOrThrow({
      where: { id: Number(appointmentId) },
    });
    expect(saved.scheduledTime).toBe("09:00");
  });

  it("the appointment list takes no write: 405 for Operate warehouse, 403 for the rest", async () => {
    await makeStaff("owner", "SUPER_ADMIN");
    await makeStaff("dee", "DESIGNER");

    signInAs("dee");
    expect(await status(appointmentsRoute, "GET")).toBe(200);
    expect(await status(appointmentsRoute, "POST")).toBe(403);
    signInAs("owner");
    expect(await status(appointmentsRoute, "POST")).toBe(405); // was 403
  });

  it("the installer picker reads on Operate warehouse; adding an installer is setup", async () => {
    await makeStaff("dan", "DISPATCH");
    await makeStaff("dee", "DESIGNER");
    await makeStaff("mia", "MANAGER");

    signInAs("dan");
    expect(await status(installersRoute, "GET", { active: "true" })).toBe(200); // was 403
    expect(await status(installersRoute, "POST", {}, { name: "Crew A" })).toBe(403);

    signInAs("dee");
    expect(await status(installersRoute, "GET", { active: "true" })).toBe(403);

    signInAs("mia");
    const created = await call(installersRoute, "POST", {}, { name: "Crew A" });
    expect(created.statusCode).toBe(201);
    const installerId = String((created.body as { id: number }).id);
    expect(await status(installerRoute, "PUT", { id: installerId }, { notes: "Weekends" })).toBe(
      200,
    );

    signInAs("dan");
    expect(await status(installerRoute, "PUT", { id: installerId }, { notes: "Nights" })).toBe(403);
  });
});

describe("service setup stays with the Owner, Administrators and Managers", () => {
  it("Managers set up delivery zones, their ZIPs and email templates", async () => {
    await makeStaff("mia", "MANAGER");
    signInAs("mia");

    const zone = await call(zonesRoute, "POST", {}, { name: "North", baseFee: 50 });
    expect(zone.statusCode).toBe(201);
    const zoneId = String((zone.body as { id: number }).id);
    expect(await status(zoneZipsRoute, "POST", { id: zoneId }, { zipCodes: ["60601"] })).toBe(200);
    expect(await status(templatesRoute, "GET")).toBe(200);
    expect(
      await status(
        templatesRoute,
        "POST",
        {},
        {
          name: "Install booked",
          subject: "Your install",
          body: "See you then.",
          category: "INSTALL",
        },
      ),
    ).toBe(201);
  });

  it("General Managers, the crews, the service desk and designers hold no setup key", async () => {
    await makeStaff("gina", "GENERAL_MANAGER");
    await makeStaff("wes", "WAREHOUSE");
    await makeStaff("dan", "DISPATCH");
    await makeStaff("cara", "CUSTOMER_SERVICE");
    await makeStaff("dee", "DESIGNER");

    for (const userId of ["gina", "wes", "dan", "cara", "dee"]) {
      signInAs(userId);
      expect(await status(zonesRoute, "GET")).toBe(403);
      expect(await status(zonesRoute, "POST", {}, { name: "South", baseFee: 75 })).toBe(403);
      expect(await status(templatesRoute, "GET")).toBe(403);
    }
  });

  it("the Owner is refused none of it", async () => {
    await makeStaff("owner", "SUPER_ADMIN");
    signInAs("owner");

    expect(await status(zonesRoute, "GET")).toBe(200);
    expect(await status(templatesRoute, "GET")).toBe(200);
    expect(await status(installersRoute, "GET")).toBe(200);
    expect(await status(typesRoute, "POST", {}, { name: "Warranty" })).toBe(201);
  });
});

describe("the setup routes ask for Set up service, not another Manager key", () => {
  // Below the Administrator, only Managers hold Set up service, and they also
  // hold several keys no other built-in role does (Bill customers directly, Set
  // up the chart of accounts, View management reports...). So the built-in
  // roles above pass whichever of those a setup route asked for. Two roles
  // built in Roles tell them apart: one holding only Set up service, and one
  // holding every other key a Manager holds.
  const template = {
    name: "Install booked",
    subject: "Your install",
    body: "See you then.",
    category: "INSTALL",
  };

  it("a role holding only Set up service makes every setup write", async () => {
    await makeCustomRoleStaff("sam", ["service.setup"]);
    signInAs("sam");

    const zone = await call(zonesRoute, "POST", {}, { name: "North", baseFee: 50 });
    expect(zone.statusCode).toBe(201);
    const zoneId = String((zone.body as { id: number }).id);
    expect(await status(zoneRoute, "PUT", { id: zoneId }, { baseFee: 60 })).toBe(200);
    expect(await status(zoneZipsRoute, "POST", { id: zoneId }, { zipCodes: ["60601"] })).toBe(200);

    const installer = await call(installersRoute, "POST", {}, { name: "Crew A" });
    expect(installer.statusCode).toBe(201);
    const installerId = String((installer.body as { id: number }).id);
    expect(await status(installerRoute, "PUT", { id: installerId }, { notes: "Weekends" })).toBe(
      200,
    );

    expect(await status(typesRoute, "POST", {}, { name: "Warranty" })).toBe(201);
    expect(
      await status(typeRoute, "PUT", { id: String(lookups.typeId) }, { name: "Repairs" }),
    ).toBe(200);
    expect(await status(statusesRoute, "POST", {}, { name: "Waiting on vendor" })).toBe(201);
    expect(
      await status(statusRoute, "PUT", { id: String(lookups.statusId) }, { name: "Opened" }),
    ).toBe(200);
    expect(await status(prioritiesRoute, "POST", {}, { name: "High" })).toBe(201);
    expect(
      await status(priorityRoute, "PUT", { id: String(lookups.priorityId) }, { name: "Routine" }),
    ).toBe(200);

    const created = await call(templatesRoute, "POST", {}, template);
    expect(created.statusCode).toBe(201);
    const templateId = String((created.body as { id: number }).id);
    expect(
      await status(templateRoute, "PUT", { id: templateId }, { subject: "Your install date" }),
    ).toBe(200);
  });

  it("a role holding every other Manager key makes none of them", async () => {
    const everyOtherManagerKey = stripBaselinePermissions(
      permissionsForBuiltInRole("MANAGER"),
    ).filter((key) => key !== "service.setup");
    await makeCustomRoleStaff("almost", everyOtherManagerKey);
    signInAs("almost");

    const one = { id: "1" };
    const writes: Array<[string, Route, string, Record<string, string>]> = [
      ["delivery-zones", zonesRoute, "POST", {}],
      ["delivery-zones/[id]", zoneRoute, "PUT", one],
      ["delivery-zones/[id]/zips", zoneZipsRoute, "POST", one],
      ["delivery-zones/[id]/zips", zoneZipsRoute, "DELETE", one],
      ["installers", installersRoute, "POST", {}],
      ["installers/[id]", installerRoute, "PUT", one],
      ["settings/types", typesRoute, "POST", {}],
      ["settings/types/[id]", typeRoute, "PUT", one],
      ["settings/types/[id]", typeRoute, "DELETE", one],
      ["settings/statuses", statusesRoute, "POST", {}],
      ["settings/statuses/[id]", statusRoute, "PUT", one],
      ["settings/statuses/[id]", statusRoute, "DELETE", one],
      ["settings/priorities", prioritiesRoute, "POST", {}],
      ["settings/priorities/[id]", priorityRoute, "PUT", one],
      ["settings/priorities/[id]", priorityRoute, "DELETE", one],
      ["email-templates", templatesRoute, "POST", {}],
      ["email-templates/[id]", templateRoute, "PUT", one],
      ["email-templates/[id]", templateRoute, "DELETE", one],
    ];
    for (const [path, route, method, query] of writes) {
      expect({ path, method, status: await status(route, method, query, template) }).toEqual({
        path,
        method,
        status: 403,
      });
    }

    // What its other keys open is untouched: the case lists through View
    // service, the installer picker through Operate warehouse.
    expect(await status(typesRoute, "GET")).toBe(200);
    expect(await status(installersRoute, "GET", { active: "true" })).toBe(200);
  });
});

describe("the bookable-services catalog", () => {
  it("is Change settings: the Owner and Administrators, not Managers", async () => {
    await makeStaff("owner", "SUPER_ADMIN");
    await makeStaff("mia", "MANAGER");

    signInAs("mia");
    expect(await status(bookableServicesRoute, "GET")).toBe(403);
    expect(
      await status(
        bookableServicesRoute,
        "POST",
        {},
        { name: "Design consult", durationMinutes: 60 },
      ),
    ).toBe(403);

    signInAs("owner");
    expect(await status(bookableServicesRoute, "GET")).toBe(200);
    signInAs("admin");
    expect(await status(bookableServicesRoute, "GET")).toBe(200);
  });
});
