// /app/__tests__/ticketNumbering.test.ts

import { ticketNumberPrefix, nextTicketNumber } from "@/lib/tickets/numbering";

describe("ticket numbering", () => {
  it("builds the date prefix in TKT-YYMMDD- form", () => {
    // Local-time constructor: 2026-06-03 -> month index 5 = June.
    expect(ticketNumberPrefix(new Date(2026, 5, 3))).toBe("TKT-260603-");
    expect(ticketNumberPrefix(new Date(2026, 11, 25))).toBe("TKT-261225-");
  });

  it("starts at 001 when there is no prior ticket for the day", () => {
    expect(nextTicketNumber("TKT-260603-", null)).toBe("TKT-260603-001");
  });

  it("increments the sequence from the last ticket", () => {
    expect(nextTicketNumber("TKT-260603-", "TKT-260603-001")).toBe("TKT-260603-002");
    expect(nextTicketNumber("TKT-260603-", "TKT-260603-041")).toBe("TKT-260603-042");
  });

  it("falls back to 001 when the last number is unparseable", () => {
    expect(nextTicketNumber("TKT-260603-", "garbage")).toBe("TKT-260603-001");
  });
});
