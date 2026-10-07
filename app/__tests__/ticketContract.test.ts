// /app/__tests__/ticketContract.test.ts

import {
  TICKET_STATUS_VALUES,
  TICKET_PRIORITY_VALUES,
  TICKET_STATUS_LABELS,
  TICKET_PRIORITY_LABELS,
  TICKET_PRIORITY_RANK,
  isValidTicketTransition,
  getValidTicketTransitions,
  isOpenTicketStatus,
  isResolvedTicketStatus,
} from "@/lib/tickets/ticketContract";

describe("ticket contract", () => {
  it("declares the expected status + priority value sets", () => {
    expect(TICKET_STATUS_VALUES).toEqual([
      "OPEN",
      "IN_PROGRESS",
      "WAITING_ON_CUSTOMER",
      "RESOLVED",
      "CLOSED",
    ]);
    expect(TICKET_PRIORITY_VALUES).toEqual(["LOW", "MEDIUM", "HIGH", "URGENT"]);
  });

  it("has a label for every status + priority", () => {
    for (const s of TICKET_STATUS_VALUES) expect(TICKET_STATUS_LABELS[s]).toBeTruthy();
    for (const p of TICKET_PRIORITY_VALUES) expect(TICKET_PRIORITY_LABELS[p]).toBeTruthy();
  });

  describe("transitions", () => {
    it("allows moving an open ticket forward", () => {
      expect(isValidTicketTransition("OPEN", "IN_PROGRESS")).toBe(true);
      expect(isValidTicketTransition("IN_PROGRESS", "RESOLVED")).toBe(true);
      expect(isValidTicketTransition("RESOLVED", "CLOSED")).toBe(true);
    });

    it("allows reopening a done ticket but nothing else from CLOSED", () => {
      expect(isValidTicketTransition("CLOSED", "OPEN")).toBe(true);
      expect(isValidTicketTransition("CLOSED", "IN_PROGRESS")).toBe(false);
      expect(getValidTicketTransitions("CLOSED")).toEqual(["OPEN"]);
    });

    it("treats a no-op same-status save as valid", () => {
      expect(isValidTicketTransition("OPEN", "OPEN")).toBe(true);
    });
  });

  describe("status predicates", () => {
    it("counts OPEN/IN_PROGRESS/WAITING as open", () => {
      expect(isOpenTicketStatus("OPEN")).toBe(true);
      expect(isOpenTicketStatus("IN_PROGRESS")).toBe(true);
      expect(isOpenTicketStatus("WAITING_ON_CUSTOMER")).toBe(true);
      expect(isOpenTicketStatus("RESOLVED")).toBe(false);
      expect(isOpenTicketStatus("CLOSED")).toBe(false);
    });

    it("counts RESOLVED/CLOSED as resolved", () => {
      expect(isResolvedTicketStatus("RESOLVED")).toBe(true);
      expect(isResolvedTicketStatus("CLOSED")).toBe(true);
      expect(isResolvedTicketStatus("OPEN")).toBe(false);
    });
  });

  it("ranks URGENT above LOW for queue sorting", () => {
    const order = [...TICKET_PRIORITY_VALUES].sort(
      (a, b) => TICKET_PRIORITY_RANK[a] - TICKET_PRIORITY_RANK[b],
    );
    expect(order).toEqual(["URGENT", "HIGH", "MEDIUM", "LOW"]);
  });
});
