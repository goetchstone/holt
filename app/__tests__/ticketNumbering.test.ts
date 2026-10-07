// /app/__tests__/ticketNumbering.test.ts

import { ticketNumberPrefix, nextTicketNumber } from "@/lib/tickets/numbering";

describe("ticket numbering", () => {
  it("builds the date prefix in TKT-YYMMDD- form", () => {
    expect(ticketNumberPrefix(new Date("2026-06-03T15:00:00Z"), "UTC")).toBe("TKT-260603-");
    expect(ticketNumberPrefix(new Date("2026-12-25T15:00:00Z"), "UTC")).toBe("TKT-261225-");
  });

  // QUA-14: the business's day, not the server's. 02:00 UTC on 4 June is still
  // 22:00 on 3 June in New York; a UTC server used to stamp it the 4th.
  it("dates the prefix by the business day in its timezone", () => {
    const evening = new Date("2026-06-04T02:00:00Z");
    expect(ticketNumberPrefix(evening, "America/New_York")).toBe("TKT-260603-");
    expect(ticketNumberPrefix(evening, "UTC")).toBe("TKT-260604-");
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
