// /app/__tests__/clientOwnership.test.ts
//
// Whose pipeline a quote is in. Names are the kinds found in imported
// data: register logins and people with no staff record, plus staff who have left.

import {
  findQuoteOwnerId,
  isQuoteInStaffPipeline,
  isQuoteOwned,
  nameMatchesActiveStaff,
  parseAssignClientsBody,
} from "@/lib/clientOwnership";

const activeStaff = [
  { id: 1, displayName: "Nora", aliases: ["Nora D", "NORA DORN"] },
  { id: 2, displayName: "Iris Fenn", aliases: [] },
];

const noCustomer = { customer: null };

describe("isQuoteOwned", () => {
  it("is owned by an active salesperson's id", () => {
    const quote = { salesPersonId: 1, salesperson: "FrontRegister4", ...noCustomer };
    expect(isQuoteOwned(quote, activeStaff)).toBe(true);
  });

  it("is owned by an active salesperson's name, ignoring case", () => {
    const quote = { salesPersonId: null, salesperson: "NORA dorn", ...noCustomer };
    expect(isQuoteOwned(quote, activeStaff)).toBe(true);
  });

  it("has no owner under a register login, a name with no staff record, or no name", () => {
    const owned = (salesperson: string | null) =>
      isQuoteOwned({ salesPersonId: null, salesperson, ...noCustomer }, activeStaff);
    expect(owned("FrontRegister4")).toBe(false);
    expect(owned("Iris Bell")).toBe(false);
    expect(owned(null)).toBe(false);
  });

  it("has no owner when the id belongs to someone who left", () => {
    const quote = { salesPersonId: 99, salesperson: "Tess Marlow Quill", ...noCustomer };
    expect(isQuoteOwned(quote, activeStaff)).toBe(false);
  });

  it("is owned once the client is assigned to someone active, but not someone who left", () => {
    const quote = { salesPersonId: null, salesperson: "FrontRegister4" };
    const assigned = (primaryDesignerId: number) =>
      isQuoteOwned({ ...quote, customer: { primaryDesignerId } }, activeStaff);
    expect(assigned(1)).toBe(true);
    expect(assigned(99)).toBe(false);
  });
});

describe("findQuoteOwnerId", () => {
  it("puts the person the sale is credited to ahead of the assigned primary designer", () => {
    const quote = { salesPersonId: 2, salesperson: null, customer: { primaryDesignerId: 1 } };
    expect(findQuoteOwnerId(quote, activeStaff)).toBe(2);
  });

  it("won't let a name overrule a linked id: someone who left goes to the primary designer", () => {
    const byName = { salesPersonId: 99, salesperson: "Nora", customer: null };
    expect(findQuoteOwnerId(byName, activeStaff)).toBeNull();
    const assigned = { salesPersonId: 99, salesperson: "Tess", customer: { primaryDesignerId: 2 } };
    expect(findQuoteOwnerId(assigned, activeStaff)).toBe(2);
  });

  it("returns null when nobody active has it", () => {
    const quote = { salesPersonId: null, salesperson: "FrontRegister1", customer: null };
    expect(findQuoteOwnerId(quote, activeStaff)).toBeNull();
  });
});

describe("isQuoteInStaffPipeline", () => {
  const nora = activeStaff[0];
  const julia = activeStaff[1];
  const assignedToNora = { customer: { primaryDesignerId: nora.id } };

  it("includes quotes the sale is credited to to them", () => {
    const byId = { salesPersonId: nora.id, salesperson: null, customer: null };
    const byName = { salesPersonId: null, salesperson: "Nora", customer: null };
    expect(isQuoteInStaffPipeline(byId, nora, activeStaff)).toBe(true);
    expect(isQuoteInStaffPipeline(byName, nora, activeStaff)).toBe(true);
  });

  it("includes an assigned client's quote only when no active salesperson has it", () => {
    const ownerless = { salesPersonId: 99, salesperson: "Tess", ...assignedToNora };
    const colleagues = {
      salesPersonId: julia.id,
      salesperson: "Iris Fenn",
      ...assignedToNora,
    };
    expect(isQuoteInStaffPipeline(ownerless, nora, activeStaff)).toBe(true);
    expect(isQuoteInStaffPipeline(colleagues, nora, activeStaff)).toBe(false);
  });

  it("keeps a colleague's credited quote in their own pipeline after the client is assigned", () => {
    const colleagues = {
      salesPersonId: julia.id,
      salesperson: "Iris Fenn",
      ...assignedToNora,
    };
    expect(isQuoteInStaffPipeline(colleagues, julia, activeStaff)).toBe(true);
  });

  it("leaves out other people's quotes", () => {
    const quote = { salesPersonId: null, salesperson: "FrontRegister1", customer: null };
    expect(isQuoteInStaffPipeline(quote, nora, activeStaff)).toBe(false);
  });
});

describe("nameMatchesActiveStaff", () => {
  it("handles an empty name", () => {
    expect(nameMatchesActiveStaff(null, activeStaff)).toBe(false);
    expect(nameMatchesActiveStaff("", activeStaff)).toBe(false);
  });
});

describe("parseAssignClientsBody", () => {
  it("reads one client", () => {
    expect(parseAssignClientsBody({ customerId: 5, toStaffId: 7 })).toEqual({
      ok: true,
      kind: "one",
      customerId: 5,
      toStaffId: 7,
    });
  });

  it("reads everyone matching a list, keeping its filters", () => {
    const parsed = parseAssignClientsBody({
      toStaffId: 7,
      workedWith: "Tess Marlow Quill",
      expectedCount: 92,
      lastOrder: "over2y",
    });
    expect(parsed).toMatchObject({
      ok: true,
      kind: "all-matching",
      expectedCount: 92,
      toStaffId: 7,
      options: { workedWith: "Tess Marlow Quill", lastOrder: "over2y" },
    });
  });

  it("refuses a bulk assign with no worked-with name, so the whole list can't go by accident", () => {
    expect(parseAssignClientsBody({ toStaffId: 7, expectedCount: 2304 }).ok).toBe(false);
  });

  it.each([
    [{}],
    [undefined],
    [{ customerId: 5 }],
    [{ customerId: "5", toStaffId: 7 }],
    [{ customerId: 0, toStaffId: 7 }],
    [{ toStaffId: 7, workedWith: "Tess" }],
    [{ toStaffId: 7, workedWith: "Tess", expectedCount: 0 }],
  ])("rejects %j", (body) => {
    expect(parseAssignClientsBody(body).ok).toBe(false);
  });
});

describe("who a name means", () => {
  const ann = { id: 10, displayName: "Ann", aliases: [] };
  const anna = { id: 11, displayName: "Anna Reyes", aliases: ["Reyes, Anna"] };
  const quote = (salesperson: string | null, salesPersonId: number | null = null) => ({
    salesPersonId,
    salesperson,
    customer: null,
  });

  it("takes the whole name, so Ann isn't Anna Reyes, whoever comes first", () => {
    expect(findQuoteOwnerId(quote("Anna Reyes"), [ann, anna])).toBe(anna.id);
    expect(findQuoteOwnerId(quote("Anna Reyes"), [anna, ann])).toBe(anna.id);
    expect(isQuoteInStaffPipeline(quote("Anna Reyes"), ann, [ann, anna])).toBe(false);
    expect(nameMatchesActiveStaff("Annabel", [ann])).toBe(false);
  });

  it("takes an alias, for a POS that writes names its own way", () => {
    expect(findQuoteOwnerId(quote("Reyes, Anna"), [ann, anna])).toBe(anna.id);
    expect(isQuoteInStaffPipeline(quote("reyes, anna"), anna, [ann, anna])).toBe(true);
    expect(nameMatchesActiveStaff("Reyes, Anna", [anna])).toBe(true);
  });

  it("ignores case and stray spaces", () => {
    expect(findQuoteOwnerId(quote("  anna REYES "), [anna])).toBe(anna.id);
  });

  it("goes by the linked id when there is one, even if the name says otherwise", () => {
    expect(isQuoteInStaffPipeline(quote("Ann", anna.id), ann, [ann, anna])).toBe(false);
    expect(isQuoteInStaffPipeline(quote("Ann", anna.id), anna, [ann, anna])).toBe(true);
    expect(findQuoteOwnerId(quote("Ann", anna.id), [ann, anna])).toBe(anna.id);
  });

  it("means no one when there's no name", () => {
    expect(findQuoteOwnerId(quote(""), [{ ...ann, aliases: [""] }])).toBeNull();
    expect(findQuoteOwnerId(quote("   "), [ann])).toBeNull();
  });
});
