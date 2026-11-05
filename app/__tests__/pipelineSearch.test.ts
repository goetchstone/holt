// /app/__tests__/pipelineSearch.test.ts
//
// The pipeline search (GAP-36): a manager searches every open quote, a salesperson
// only their own, and each word matches across names, notes and client info.

import { pipelineSearchWhere } from "@/lib/pipelineSearch";

const manager = {
  canViewAll: true,
  staff: { id: 1, displayName: "Mo Ames", aliases: [] },
  includeArchived: false,
};
const salesperson = {
  canViewAll: false,
  staff: { id: 7, displayName: "Pat Lund", aliases: ["P Lund"] },
  includeArchived: false,
};

describe("pipelineSearchWhere", () => {
  it("scopes to open, active quotes and splits the search into one filter per word", () => {
    const where = pipelineSearchWhere("nora vale", manager);
    expect(where.status).toBe("QUOTE");
    expect(where.pipelineArchivedAt).toBeNull();
    expect(where.AND).toHaveLength(2);
  });

  it("searches notes and client info as well as names", () => {
    const where = pipelineSearchWhere("summer", manager);
    const tokenOr = (where.AND as { OR: object[] }[])[0].OR;
    const contains = { contains: "summer", mode: "insensitive" };
    expect(tokenOr).toEqual(
      expect.arrayContaining([
        { customer: { firstName: contains } },
        { customer: { clientProfile: { searchText: contains } } },
        { interactions: { some: { notes: contains } } },
        { pipelineNote: contains },
      ]),
    );
  });

  it("reaches a note on the client's other quotes only if it's a client note", () => {
    const where = pipelineSearchWhere("summer", manager);
    const tokenOr = (where.AND as { OR: object[] }[])[0].OR;
    expect(tokenOr).toContainEqual({
      customer: {
        interactions: {
          some: { source: "NOTE", notes: { contains: "summer", mode: "insensitive" } },
        },
      },
    });
  });

  it("doesn't limit a manager to anyone's quotes", () => {
    expect(pipelineSearchWhere("nora", manager).OR).toBeUndefined();
  });

  it("limits a salesperson to their own, by id, by whole name or alias, or by owning the client", () => {
    expect(pipelineSearchWhere("nora", salesperson).OR).toEqual([
      { salesPersonId: 7 },
      { salesPersonId: null, salesperson: { equals: "Pat Lund", mode: "insensitive" } },
      { salesPersonId: null, salesperson: { equals: "P Lund", mode: "insensitive" } },
      { customer: { primaryDesignerId: 7 } },
    ]);
  });

  it("honors the archived flag", () => {
    expect(pipelineSearchWhere("nora", manager).pipelineArchivedAt).toBeNull();
    expect(
      pipelineSearchWhere("nora", { ...manager, includeArchived: true }).pipelineArchivedAt,
    ).toEqual({ not: null });
  });
});
