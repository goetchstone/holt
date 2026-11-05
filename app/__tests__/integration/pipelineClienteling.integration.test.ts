// /app/__tests__/integration/pipelineClienteling.integration.test.ts
//
// The pipeline's client side against a real DB: note search, a client's notes,
// what they last bought, and each salesperson's client book. These all hinge on
// query shape (attribution OR, filtered relations, distinct-per-customer), which
// mocked Prisma can't catch. The route-level behaviour is in clientBookRoutes.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import { assignClients, assignMatchingClients } from "@/lib/clientAssign";
import { isQuoteInStaffPipeline } from "@/lib/clientOwnership";
import { fetchClientBook, fetchUnassignedClients } from "@/lib/clientBookQuery";
import { parseClientBookOptions } from "@/lib/clientBook";
import { pipelineSearchWhere, staffPipelineWhere } from "@/lib/pipelineSearch";
import {
  fetchClientBackground,
  fetchClientNotesByCustomer,
  fetchLastPurchaseByCustomer,
} from "@/lib/pipelineClientQuery";

let orderSeq = 0;
const NOW = new Date("2026-11-04T12:00:00.000Z");

type OrderStatus = "QUOTE" | "ORDER" | "FULFILLED" | "RETURNED";

async function makeStaff(displayName: string, isActive = true) {
  return prisma.staffMember.create({
    data: { displayName, isActive, email: `${displayName}@test.dev` },
  });
}

async function makeCustomer(firstName: string, lastName: string, over: object = {}) {
  return prisma.customer.create({ data: { firstName, lastName, ...over } });
}

async function makeOrder(
  customerId: number,
  over: {
    status?: OrderStatus;
    orderDate?: string;
    salesPersonId?: number | null;
    splitWithId?: number | null;
    salesperson?: string | null;
    archived?: boolean;
  } = {},
) {
  orderSeq += 1;
  return prisma.salesOrder.create({
    data: {
      orderno: `TEST${orderSeq}`,
      customerId,
      status: over.status ?? "ORDER",
      orderDate: new Date(over.orderDate ?? "2026-10-01T00:00:00.000Z"),
      salesPersonId: over.salesPersonId ?? null,
      splitWithId: over.splitWithId ?? null,
      salesperson: over.salesperson ?? null,
      pipelineArchivedAt: over.archived ? NOW : null,
    },
  });
}

async function makeLine(
  salesOrderId: number,
  productName: string,
  over: {
    netPrice?: number;
    orderedQuantity?: number;
    cancelled?: boolean;
    serviceProduct?: "MEASURE" | "HOUSE_CALL";
  } = {},
) {
  let productId: number | undefined;
  if (over.serviceProduct) {
    const suffix = `${salesOrderId}-${over.serviceProduct}`;
    const vendor = await prisma.vendor.create({ data: { name: `Service vendor ${suffix}` } });
    const department = await prisma.department.create({ data: { name: `Services ${suffix}` } });
    const category = await prisma.category.create({
      data: { name: `Services ${suffix}`, departmentId: department.id },
    });
    const product = await prisma.product.create({
      data: {
        productNumber: `SVC-${suffix}`,
        name: productName,
        serviceType: over.serviceProduct,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
    productId = product.id;
  }
  return prisma.orderLineItem.create({
    data: {
      salesOrderId,
      productId,
      productName,
      partNo: productName,
      orderedQuantity: over.orderedQuantity ?? 1,
      netPrice: over.netPrice ?? 100,
      cost: 0,
      lineItemStatus: over.cancelled ? "CANCELLED" : "ACTIVE",
    },
  });
}

async function makeInteraction(
  staffMemberId: number,
  over: {
    customerId?: number;
    salesOrderId?: number;
    source?: string;
    notes?: string;
    at?: string;
  },
) {
  return prisma.customerInteraction.create({
    data: {
      staffMemberId,
      customerId: over.customerId ?? null,
      salesOrderId: over.salesOrderId ?? null,
      storeLocation: "Mill",
      source: over.source ?? "NOTE",
      notes: over.notes ?? null,
      startedAt: new Date(over.at ?? "2026-10-15T12:00:00.000Z"),
      isActive: false,
    },
  });
}

function bookOptions(query: Record<string, unknown> = {}) {
  return parseClientBookOptions(query);
}

beforeEach(async () => {
  await resetTestDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("pipelineSearchWhere (real DB)", () => {
  const viewerFor = (staff: { id: number; displayName: string }, canViewAll: boolean) => ({
    canViewAll,
    staff: { id: staff.id, displayName: staff.displayName, aliases: [] },
    includeArchived: false,
  });

  async function search(term: string, viewer: ReturnType<typeof viewerFor>) {
    const rows = await prisma.salesOrder.findMany({
      where: pipelineSearchWhere(term, viewer),
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  it("finds a quote by a follow-up note, a client note on another quote, or the description", async () => {
    const nora = await makeStaff("Nora");
    const viewer = viewerFor(nora, false);
    const owned = { status: "QUOTE" as const, salesPersonId: nora.id };

    const onFollowUp = await makeCustomer("Ann", "Follow");
    const followUpQuote = await makeOrder(onFollowUp.id, owned);
    await makeInteraction(nora.id, {
      customerId: onFollowUp.id,
      salesOrderId: followUpQuote.id,
      source: "PHONE",
      notes: "Furnishing their Summer Home",
    });

    const onClientNote = await makeCustomer("Bea", "Note");
    const clientNoteQuote = await makeOrder(onClientNote.id, owned);
    await makeInteraction(nora.id, {
      customerId: onClientNote.id,
      notes: "summer home in Lakeside",
    });

    const onDescription = await makeCustomer("Cal", "Profile");
    const descriptionQuote = await makeOrder(onDescription.id, owned);
    await prisma.clientProfile.create({
      data: { customerId: onDescription.id, searchText: "A summer home refresh" },
    });

    const unrelated = await makeCustomer("Dee", "Other");
    await makeOrder(unrelated.id, owned);

    const found = await search("summer home", viewer);
    expect(found.sort((a, b) => a - b)).toEqual(
      [followUpQuote.id, clientNoteQuote.id, descriptionQuote.id].sort((a, b) => a - b),
    );
  });

  it("doesn't match on a follow-up from a client's other quote, which the card can't show", async () => {
    const nora = await makeStaff("Nora");
    const client = await makeCustomer("Ann", "Follow");
    const shown = await makeOrder(client.id, { status: "QUOTE", salesPersonId: nora.id });
    const other = await makeOrder(client.id, { status: "QUOTE", salesPersonId: nora.id });
    await makeInteraction(nora.id, {
      customerId: client.id,
      salesOrderId: other.id,
      source: "PHONE",
      notes: "lake house",
    });

    expect(await search("lake", viewerFor(nora, false))).toEqual([other.id]);
    expect(await search("lake", viewerFor(nora, false))).not.toContain(shown.id);
  });

  it("still matches full names across first and last", async () => {
    const nora = await makeStaff("Nora");
    const client = await makeCustomer("Jane", "Smith");
    const quote = await makeOrder(client.id, { status: "QUOTE", salesPersonId: nora.id });
    expect(await search("jane smith", viewerFor(nora, false))).toEqual([quote.id]);
  });

  it("keeps a designer to their own quotes while a manager sees everyone's", async () => {
    const nora = await makeStaff("Nora");
    const kim = await makeStaff("Lena");
    const client = await makeCustomer("Ann", "Follow");
    const quote = await makeOrder(client.id, { status: "QUOTE", salesPersonId: kim.id });
    await makeInteraction(kim.id, { customerId: client.id, notes: "summer home" });

    expect(await search("summer", viewerFor(nora, false))).toEqual([]);
    expect(await search("summer", viewerFor(nora, true))).toEqual([quote.id]);
  });
});

describe("fetchClientBackground (real DB)", () => {
  async function makeBrandLine(orderId: number, vendorName: string, netPrice: number) {
    const vendor = await prisma.vendor.upsert({
      where: { name: vendorName },
      update: {},
      create: { name: vendorName },
    });
    const department = await prisma.department.upsert({
      where: { name: "Furniture" },
      update: {},
      create: { name: "Furniture" },
    });
    const category = await prisma.category.upsert({
      where: { name_departmentId: { name: "Seating", departmentId: department.id } },
      update: {},
      create: { name: "Seating", departmentId: department.id },
    });
    orderSeq += 1;
    const product = await prisma.product.create({
      data: {
        productNumber: `P${orderSeq}`,
        name: `Item ${orderSeq}`,
        vendorId: vendor.id,
        departmentId: department.id,
        categoryId: category.id,
      },
    });
    await prisma.orderLineItem.create({
      data: {
        salesOrderId: orderId,
        productId: product.id,
        productName: product.name,
        orderedQuantity: 2,
        netPrice,
        cost: 0,
      },
    });
  }

  it("ranks brands by line total, leaving out returns and quotes", async () => {
    const ann = await makeCustomer("Ann", "Follow");
    const sale = await makeOrder(ann.id);
    await makeBrandLine(sale.id, "Alder Works", 300);
    await makeBrandLine(sale.id, "Birch Hall", 500);
    const returned = await makeOrder(ann.id, { status: "RETURNED" });
    await makeBrandLine(returned.id, "Returned Brand", 9000);
    const quote = await makeOrder(ann.id, { status: "QUOTE" });
    await makeBrandLine(quote.id, "Quoted Brand", 9000);

    const background = (await fetchClientBackground([ann.id])).get(ann.id);
    expect(background?.brands).toEqual(["Birch Hall", "Alder Works"]);
  });

  it("lists each town on file once and returns empties for a client with neither", async () => {
    const ann = await makeCustomer("Ann", "Follow");
    const bea = await makeCustomer("Bea", "Empty");
    const address = { address1: "1 Main St", zip: "00000" };
    await prisma.customerAddress.createMany({
      data: [
        { customerId: ann.id, city: "Lakeside", state: "ME", ...address },
        { customerId: ann.id, city: "Lakeside", state: "ME", ...address },
        { customerId: ann.id, city: "Seaview", state: "FL", ...address },
      ],
    });

    const background = await fetchClientBackground([ann.id, bea.id]);
    expect(background.get(ann.id)?.locations).toEqual(["Lakeside, ME", "Seaview, FL"]);
    expect(background.get(bea.id)).toEqual({ lastPurchase: null, brands: [], locations: [] });
  });

  it("finds a client in the book by a brand they bought", async () => {
    const nora = await makeStaff("Nora");
    const buyer = await makeCustomer("Ann", "Buyer");
    const other = await makeCustomer("Bea", "Other");
    const sale = await makeOrder(buyer.id, { salesPersonId: nora.id });
    await makeBrandLine(sale.id, "Birch Hall", 500);
    await makeOrder(other.id, { salesPersonId: nora.id });

    const { rows } = await fetchClientBook(nora, bookOptions({ search: "birch hall" }), NOW);
    expect(rows.map((row) => row.id)).toEqual([buyer.id]);
    expect(rows[0].history.brands).toEqual(["Birch Hall"]);
  });
});

describe("fetchClientNotesByCustomer (real DB)", () => {
  it("returns only client notes, newest first, keyed by client", async () => {
    const nora = await makeStaff("Nora");
    const ann = await makeCustomer("Ann", "Follow");
    const bea = await makeCustomer("Bea", "Note");
    await makeInteraction(nora.id, {
      customerId: ann.id,
      notes: "older",
      at: "2026-10-01T12:00:00.000Z",
    });
    await makeInteraction(nora.id, {
      customerId: ann.id,
      notes: "newer",
      at: "2026-10-20T12:00:00.000Z",
    });
    await makeInteraction(nora.id, { customerId: ann.id, source: "PHONE", notes: "a call" });
    await makeInteraction(nora.id, { customerId: bea.id, notes: "other client" });

    const notes = await fetchClientNotesByCustomer([ann.id]);
    expect(notes.get(ann.id)?.map((n) => n.notes)).toEqual(["newer", "older"]);
    expect(notes.has(bea.id)).toBe(false);
  });
});

describe("fetchLastPurchaseByCustomer (real DB)", () => {
  it("takes the newest sale per client, skipping returns and quotes", async () => {
    const ann = await makeCustomer("Ann", "Follow");
    const older = await makeOrder(ann.id, { orderDate: "2025-01-01T00:00:00.000Z" });
    await makeLine(older.id, "Old Chair");
    const newest = await makeOrder(ann.id, { orderDate: "2026-06-01T00:00:00.000Z" });
    await makeLine(newest.id, "New Sofa");
    await makeOrder(ann.id, { status: "RETURNED", orderDate: "2026-09-01T00:00:00.000Z" });
    await makeOrder(ann.id, { status: "QUOTE", orderDate: "2026-10-01T00:00:00.000Z" });

    const last = (await fetchLastPurchaseByCustomer([ann.id])).get(ann.id);
    expect(last?.id).toBe(newest.id);
    expect(last?.items).toEqual(["New Sofa"]);
  });

  it("lists the priciest goods, leaving out cancelled, 0-qty and service lines", async () => {
    const ann = await makeCustomer("Ann", "Follow");
    const order = await makeOrder(ann.id);
    const fee = await makeLine(order.id, "Delivery", { netPrice: 9000 });
    await prisma.salesOrder.update({
      where: { id: order.id },
      data: { deliveryFeeLineItemId: fee.id },
    });
    await makeLine(order.id, "Rug measure", { netPrice: 8000, serviceProduct: "MEASURE" });
    await makeLine(order.id, "Cancelled Table", { netPrice: 7000, cancelled: true });
    await makeLine(order.id, "Zero Qty Lamp", { netPrice: 6000, orderedQuantity: 0 });
    await makeLine(order.id, "Sofa", { netPrice: 3000 });
    await makeLine(order.id, "Chair", { netPrice: 2000 });
    await makeLine(order.id, "Rug", { netPrice: 1000 });
    await makeLine(order.id, "Pillow", { netPrice: 50 });

    const last = (await fetchLastPurchaseByCustomer([ann.id])).get(ann.id);
    expect(last?.items).toEqual(["Sofa", "Chair", "Rug"]);
  });

  it("lists a repeated product name once", async () => {
    const ann = await makeCustomer("Ann", "Follow");
    const order = await makeOrder(ann.id);
    await makeLine(order.id, "Fabric", { netPrice: 300 });
    await makeLine(order.id, "Fabric", { netPrice: 200 });
    const last = (await fetchLastPurchaseByCustomer([ann.id])).get(ann.id);
    expect(last?.items).toEqual(["Fabric"]);
  });

  it("still returns the order when it held only service lines", async () => {
    const ann = await makeCustomer("Ann", "Follow");
    const order = await makeOrder(ann.id);
    await makeLine(order.id, "House call", { serviceProduct: "HOUSE_CALL" });
    const last = (await fetchLastPurchaseByCustomer([ann.id])).get(ann.id);
    expect(last?.id).toBe(order.id);
    expect(last?.items).toEqual([]);
  });
});

describe("fetchClientBook (real DB)", () => {
  it("collects clients by salesperson id, split credit and name, and nobody else's", async () => {
    const nora = await makeStaff("Nora Vance");
    const kim = await makeStaff("Lena Pell");
    const byId = await makeCustomer("By", "Id");
    const bySplit = await makeCustomer("By", "Split");
    const byName = await makeCustomer("By", "Name");
    const others = await makeCustomer("Not", "Mine");
    await makeOrder(byId.id, { salesPersonId: nora.id });
    await makeOrder(bySplit.id, { salesPersonId: kim.id, splitWithId: nora.id });
    await makeOrder(byName.id, { salesperson: "Nora Vance" });
    await makeOrder(others.id, { salesPersonId: kim.id });

    const { rows, total } = await fetchClientBook(nora, bookOptions({ sort: "name" }), NOW);
    expect(total).toBe(3);
    expect(rows.map((row) => row.lastName)).toEqual(["Id", "Name", "Split"]);
  });

  it("collects clients booked under a salesperson's alias", async () => {
    const sandra = await prisma.staffMember.create({
      data: { displayName: "Dana Whitlow", aliases: ["Dee W"], email: "dana@test.dev" },
    });
    const client = await makeCustomer("By", "Alias");
    await makeOrder(client.id, { salesperson: "Dee W" });
    const { rows } = await fetchClientBook(sandra, bookOptions(), NOW);
    expect(rows.map((row) => row.id)).toEqual([client.id]);
  });

  it("counts orders and open quotes with this salesperson only", async () => {
    const nora = await makeStaff("Nora");
    const kim = await makeStaff("Lena");
    const client = await makeCustomer("Ann", "Follow");
    await makeOrder(client.id, { salesPersonId: nora.id, orderDate: "2025-03-01T00:00:00.000Z" });
    await makeOrder(client.id, { salesPersonId: nora.id, orderDate: "2026-03-01T00:00:00.000Z" });
    await makeOrder(client.id, { salesPersonId: kim.id, orderDate: "2026-10-01T00:00:00.000Z" });
    await makeOrder(client.id, { salesPersonId: nora.id, status: "QUOTE" });
    await makeOrder(client.id, { salesPersonId: nora.id, status: "QUOTE", archived: true });

    const { rows } = await fetchClientBook(nora, bookOptions(), NOW);
    expect(rows[0].ordersWithStaff).toBe(2);
    expect(rows[0].lastOrderWithStaff?.slice(0, 10)).toBe("2026-03-01");
    expect(rows[0].openQuotes).toBe(1);
  });

  it("includes clients who were only quoted and marks them never-bought", async () => {
    const nora = await makeStaff("Nora");
    const quoted = await makeCustomer("Only", "Quoted");
    await makeOrder(quoted.id, { salesPersonId: nora.id, status: "QUOTE", archived: true });

    const { rows } = await fetchClientBook(nora, bookOptions({ lastOrder: "never" }), NOW);
    expect(rows.map((row) => row.id)).toEqual([quoted.id]);
    expect(rows[0].lastOrderWithStaff).toBeNull();
  });

  it("includes a client whose only quote is an unpriced placeholder with no notes", async () => {
    const nora = await makeStaff("Nora");
    const client = await makeCustomer("Pat", "Placeholder");
    const quote = await makeOrder(client.id, { salesPersonId: nora.id, status: "QUOTE" });
    await makeLine(quote.id, "Quote placeholder", { netPrice: 0 });

    const { rows } = await fetchClientBook(nora, bookOptions(), NOW);
    expect(rows.map((row) => row.id)).toEqual([client.id]);
    expect(rows[0].openQuotes).toBe(1);
    expect(rows[0].notes).toEqual([]);
  });

  it("leaves out the Cash Sale placeholder and a client who only returned", async () => {
    const nora = await makeStaff("Nora");
    const cashSale = await makeCustomer("Cash", "Sale");
    const returnedOnly = await makeCustomer("Only", "Returned");
    await makeOrder(cashSale.id, { salesPersonId: nora.id });
    await makeOrder(returnedOnly.id, { salesPersonId: nora.id, status: "RETURNED" });

    expect((await fetchClientBook(nora, bookOptions(), NOW)).total).toBe(0);
  });

  it("finds clients by any note, and returns their notes newest first", async () => {
    const nora = await makeStaff("Nora");
    const noted = await makeCustomer("Ann", "Follow");
    const quiet = await makeCustomer("Bea", "Quiet");
    const order = await makeOrder(noted.id, { salesPersonId: nora.id });
    await makeOrder(quiet.id, { salesPersonId: nora.id });
    await makeInteraction(nora.id, {
      customerId: noted.id,
      salesOrderId: order.id,
      source: "EMAIL",
      notes: "Sent fabric swatches",
      at: "2026-10-01T12:00:00.000Z",
    });
    await makeInteraction(nora.id, {
      customerId: noted.id,
      notes: "Summer home in Lakeside",
      at: "2026-10-20T12:00:00.000Z",
    });

    const { rows } = await fetchClientBook(nora, bookOptions({ search: "summer home" }), NOW);
    expect(rows.map((row) => row.id)).toEqual([noted.id]);
    expect(rows[0].notes.map((note) => note.notes)).toEqual([
      "Summer home in Lakeside",
      "Sent fabric swatches",
    ]);
    expect(rows[0].notes[1].orderno).toBe(order.orderno);

    const withoutNotes = await fetchClientBook(nora, bookOptions({ notes: "withoutNotes" }), NOW);
    expect(withoutNotes.rows.map((row) => row.id)).toEqual([quiet.id]);
  });

  it("pages the book while reporting the full total", async () => {
    const nora = await makeStaff("Nora");
    for (let i = 0; i < 52; i += 1) {
      const client = await makeCustomer("Client", `Number${String(i).padStart(2, "0")}`);
      await makeOrder(client.id, { salesPersonId: nora.id });
    }
    const first = await fetchClientBook(nora, bookOptions({ sort: "name" }), NOW);
    const second = await fetchClientBook(nora, bookOptions({ sort: "name", page: "2" }), NOW);
    expect(first.total).toBe(52);
    expect(first.rows).toHaveLength(50);
    expect(second.rows.map((row) => row.lastName)).toEqual(["Number50", "Number51"]);
  });

  it("never sends wealth fields to the page", async () => {
    const nora = await makeStaff("Nora");
    const client = await makeCustomer("Ann", "Follow");
    await makeOrder(client.id, { salesPersonId: nora.id });
    await prisma.windfallEnrichment.create({
      data: { customerId: client.id, wealthTier: "ULTRA", netWorth: 90000000 },
    });
    const { rows } = await fetchClientBook(nora, bookOptions(), NOW);
    const sent = JSON.stringify(rows);
    expect(sent).not.toContain("ULTRA");
    expect(sent).not.toContain("90000000");
    expect(rows[0].leadTier).toBeTruthy();
  });
});

describe("fetchUnassignedClients (real DB)", () => {
  const unassignedNames = async () => {
    const { rows } = await fetchUnassignedClients(bookOptions({ sort: "name" }), NOW);
    return rows.map((row) => row.lastName);
  };

  it("lists clients handled only by a register login, a departed salesperson or an unknown name", async () => {
    const left = await makeStaff("Tess Left", false);
    const register = await makeCustomer("Reg", "Login");
    const departed = await makeCustomer("Dee", "Parted");
    const unknown = await makeCustomer("Una", "Known");
    await makeOrder(register.id, { salesperson: "FrontRegister4" });
    await makeOrder(departed.id, { salesPersonId: left.id, salesperson: "Tess Left" });
    await makeOrder(unknown.id, { salesperson: "Iris Bell" });

    expect(await unassignedNames()).toEqual(["Known", "Login", "Parted"]);
  });

  it("leaves out clients an active salesperson has, by id, split, name or assignment", async () => {
    const nora = await makeStaff("Nora Vance");
    const byId = await makeCustomer("By", "Id");
    const bySplit = await makeCustomer("By", "Split");
    const byName = await makeCustomer("By", "Name");
    const assigned = await makeCustomer("By", "Assigned", { primaryDesignerId: nora.id });
    await makeOrder(byId.id, { salesPersonId: nora.id });
    await makeOrder(bySplit.id, { splitWithId: nora.id, salesperson: "FrontRegister1" });
    await makeOrder(byName.id, { salesperson: "Nora Vance" });
    await makeOrder(assigned.id, { salesperson: "FrontRegister1" });

    expect(await unassignedNames()).toEqual([]);
  });

  it("counts a client assigned to someone who left as having no owner", async () => {
    const left = await makeStaff("Tess Left", false);
    const client = await makeCustomer("Dee", "Parted", { primaryDesignerId: left.id });
    await makeOrder(client.id, { salesperson: "FrontRegister1" });
    expect(await unassignedNames()).toEqual(["Parted"]);
  });

  it("lists an owned client who also has a quote in nobody's pipeline, counting only that quote", async () => {
    const nora = await makeStaff("Nora Vance");
    const client = await makeCustomer("Both", "Kinds");
    await makeOrder(client.id, { salesPersonId: nora.id });
    await makeOrder(client.id, { salesPersonId: nora.id, status: "QUOTE" });
    await makeOrder(client.id, { salesperson: "FrontRegister4", status: "QUOTE" });

    const { rows } = await fetchUnassignedClients(bookOptions(), NOW);
    expect(rows.map((row) => row.id)).toEqual([client.id]);
    expect(rows[0].openQuotes).toBe(1);
  });

  it("ignores an archived quote with no owner when the client is otherwise owned", async () => {
    const nora = await makeStaff("Nora Vance");
    const client = await makeCustomer("Mostly", "Owned");
    await makeOrder(client.id, { salesPersonId: nora.id });
    await makeOrder(client.id, { salesperson: "FrontRegister4", status: "QUOTE", archived: true });
    expect(await unassignedNames()).toEqual([]);
  });

  it("puts clients with ownerless open quotes first, and shows who they last dealt with", async () => {
    const pastOnly = await makeCustomer("Aaa", "PastOnly");
    const withQuote = await makeCustomer("Zzz", "WithQuote");
    await makeOrder(pastOnly.id, { salesperson: "FrontRegister1" });
    await makeOrder(withQuote.id, { salesperson: "BackRegister2", status: "QUOTE" });

    const { rows } = await fetchUnassignedClients(bookOptions({ sort: "name" }), NOW);
    expect(rows.map((row) => row.lastName)).toEqual(["WithQuote", "PastOnly"]);
    expect(rows[0].lastSalesperson).toBe("BackRegister2");
  });

  it("leaves out the Cash Sale placeholder", async () => {
    const cashSale = await makeCustomer("Cash", "Sale");
    await makeOrder(cashSale.id, { salesperson: "FrontRegister1", status: "QUOTE" });
    expect(await unassignedNames()).toEqual([]);
  });
});

describe("assignClients (real DB)", () => {
  const owner = (id: number) =>
    prisma.salesOrder.findUnique({
      where: { id },
      select: { salesPersonId: true, salesperson: true },
    });

  it("sets the client's owner and leaves who every order is credited to alone", async () => {
    const nora = await makeStaff("Nora Vance");
    const left = await makeStaff("Tess Left", false);
    const client = await makeCustomer("Ann", "Follow");
    const register = await makeOrder(client.id, { salesperson: "FrontRegister4", status: "QUOTE" });
    const departed = await makeOrder(client.id, {
      salesPersonId: left.id,
      salesperson: "Tess Left",
      status: "QUOTE",
    });
    const sale = await makeOrder(client.id, { salesperson: "FrontRegister4", status: "ORDER" });

    const result = await assignClients([client.id], nora.id, "manager@test.dev");
    expect(result).toEqual({ ok: true, toStaff: "Nora Vance", clientCount: 1, openQuotes: 2 });

    const customer = await prisma.customer.findUnique({ where: { id: client.id } });
    expect(customer?.primaryDesignerId).toBe(nora.id);
    expect(await owner(register.id)).toEqual({
      salesPersonId: null,
      salesperson: "FrontRegister4",
    });
    expect(await owner(departed.id)).toEqual({ salesPersonId: left.id, salesperson: "Tess Left" });
    expect(await owner(sale.id)).toEqual({ salesPersonId: null, salesperson: "FrontRegister4" });
    expect(await prisma.orderChangeLog.count()).toBe(0);
  });

  it("puts the client in the salesperson's book and off the no-owner list", async () => {
    const nora = await makeStaff("Nora Vance");
    const client = await makeCustomer("Past", "Buyer");
    await makeOrder(client.id, { salesperson: "FrontRegister1" });
    await makeOrder(client.id, { salesperson: "FrontRegister1", status: "QUOTE" });
    expect((await fetchUnassignedClients(bookOptions(), NOW)).total).toBe(1);

    await assignClients([client.id], nora.id, "manager@test.dev");

    const book = await fetchClientBook(nora, bookOptions(), NOW);
    expect(book.rows.map((row) => row.id)).toEqual([client.id]);
    expect(book.rows[0].isAssigned).toBe(true);
    expect(book.rows[0].ordersWithStaff).toBe(0);
    expect(book.rows[0].openQuotes).toBe(1);
    expect((await fetchUnassignedClients(bookOptions(), NOW)).total).toBe(0);
  });

  it("doesn't count an active salesperson's quote as the assigned person's", async () => {
    const nora = await makeStaff("Nora Vance");
    const kim = await makeStaff("Lena Pell");
    const client = await makeCustomer("Ann", "Follow");
    await makeOrder(client.id, { salesPersonId: kim.id, status: "QUOTE" });
    await makeOrder(client.id, { salesperson: "FrontRegister1", status: "QUOTE" });

    await assignClients([client.id], nora.id, "manager@test.dev");

    const book = await fetchClientBook(nora, bookOptions(), NOW);
    expect(book.rows[0].openQuotes).toBe(1);
  });

  it("refuses the Cash Sale customer, a departed salesperson and an unknown id", async () => {
    const nora = await makeStaff("Nora Vance");
    const left = await makeStaff("Tess Left", false);
    const cashSale = await makeCustomer("Cash", "Sale");
    const client = await makeCustomer("Ann", "Follow");

    expect(await assignClients([cashSale.id], nora.id, null)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await assignClients([client.id], left.id, null)).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await assignClients([client.id], 999999, null)).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await assignClients([999999], nora.id, null)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("bulk assign by who clients worked with (real DB)", () => {
  async function seedWorkedWithClients() {
    const nora = await makeStaff("Nora Vance");
    const amy = await makeStaff("Tess Left", false);
    const both = await makeCustomer("Both", "Names");
    const workedOnlyWith = await makeCustomer("Tess", "Only");
    const registerOnly = await makeCustomer("Register", "Only");
    await makeOrder(both.id, { salesPersonId: amy.id, salesperson: "Tess Left" });
    await makeOrder(both.id, { salesperson: "FrontRegister1" });
    await makeOrder(workedOnlyWith.id, {
      salesPersonId: amy.id,
      salesperson: "Tess Left",
      status: "QUOTE",
    });
    await makeOrder(registerOnly.id, { salesperson: "FrontRegister1" });
    return { nora, both, workedOnlyWith, registerOnly };
  }
  const workedWithOptions = bookOptions({ workedWith: "Tess Left" });

  it("offers former staff and register logins, not people still working here", async () => {
    const { nora, registerOnly } = await seedWorkedWithClients();
    const owned = await makeCustomer("Owned", "ButOrphanQuote");
    await makeOrder(owned.id, { salesPersonId: nora.id, salesperson: "Nora Vance" });
    await makeOrder(owned.id, { salesperson: "FrontRegister9", status: "QUOTE" });
    expect(registerOnly.id).toBeGreaterThan(0);

    const page = await fetchUnassignedClients(bookOptions(), NOW);
    expect(page.workedWithOptions).toEqual([
      { name: "FrontRegister1", clientCount: 2 },
      { name: "Tess Left", clientCount: 2 },
      { name: "FrontRegister9", clientCount: 1 },
    ]);
  });

  it("lists only the clients who worked with that person and counts their open quotes", async () => {
    const { both, workedOnlyWith } = await seedWorkedWithClients();
    const page = await fetchUnassignedClients(workedWithOptions, NOW);
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(
      [both.id, workedOnlyWith.id].sort((a, b) => a - b),
    );
    expect(page.ownerlessQuoteCount).toBe(1);
  });

  it("assigns exactly that list, and leaves every order's salesperson alone", async () => {
    const { nora, both, workedOnlyWith, registerOnly } = await seedWorkedWithClients();
    const result = await assignMatchingClients(
      workedWithOptions,
      2,
      nora.id,
      "manager@test.dev",
      NOW,
    );
    expect(result).toEqual({ ok: true, toStaff: "Nora Vance", clientCount: 2, openQuotes: 1 });

    const assigned = await prisma.customer.findMany({
      where: { primaryDesignerId: nora.id },
      select: { id: true },
    });
    expect(assigned.map((c) => c.id).sort((a, b) => a - b)).toEqual(
      [both.id, workedOnlyWith.id].sort((a, b) => a - b),
    );
    const untouched = await prisma.customer.findUnique({ where: { id: registerOnly.id } });
    expect(untouched?.primaryDesignerId).toBeNull();

    const amysOrders = await prisma.salesOrder.findMany({
      where: { customerId: { in: [both.id, workedOnlyWith.id] }, salesperson: "Tess Left" },
    });
    expect(amysOrders).toHaveLength(2);
  });

  it("refuses when the list changed since the manager saw it", async () => {
    const { nora, both } = await seedWorkedWithClients();
    const result = await assignMatchingClients(workedWithOptions, 5, nora.id, null, NOW);
    expect(result).toMatchObject({ ok: false, status: 409 });
    const customer = await prisma.customer.findUnique({ where: { id: both.id } });
    expect(customer?.primaryDesignerId).toBeNull();
  });
});

describe("staffPipelineWhere + isQuoteInStaffPipeline (real DB)", () => {
  it("shows an assigned client's ownerless quotes, not an active colleague's", async () => {
    const nora = await makeStaff("Nora Vance");
    const kim = await makeStaff("Lena Pell");
    const client = await makeCustomer("Ann", "Follow", { primaryDesignerId: nora.id });
    const register = await makeOrder(client.id, { salesperson: "FrontRegister4", status: "QUOTE" });
    await makeOrder(client.id, {
      salesPersonId: kim.id,
      salesperson: "Lena Pell",
      status: "QUOTE",
    });

    const candidates = await prisma.salesOrder.findMany({
      where: { status: "QUOTE", OR: staffPipelineWhere(nora) },
      select: {
        id: true,
        salesPersonId: true,
        salesperson: true,
        customer: { select: { primaryDesignerId: true } },
      },
    });
    const visible = candidates.filter((quote) => isQuoteInStaffPipeline(quote, nora, [nora, kim]));
    expect(visible.map((quote) => quote.id)).toEqual([register.id]);
  });
});
