// /app/__tests__/bookingIcs.test.ts
//
// A-grade unit tests for lib/booking/ics.ts. Pure -- no DB, no I/O. Pins the
// RFC 5545 shape (CRLF, UTC DTSTART/DTEND, TEXT escaping, line folding) so a
// regression in the calendar export fails red instead of producing a file that
// silently fails to import into Google/Outlook/Apple.

import { buildIcsEvent, buildIcsCalendar, escapeIcsText, formatIcsUtc } from "@/lib/booking/ics";

const start = new Date("2026-07-15T14:30:00Z");
const end = new Date("2026-07-15T15:00:00Z");
const stamp = new Date("2026-07-01T09:00:00Z");

describe("formatIcsUtc", () => {
  it("formats a Date as UTC basic form YYYYMMDDTHHMMSSZ", () => {
    expect(formatIcsUtc(start)).toBe("20260715T143000Z");
  });

  it("zero-pads single-digit components", () => {
    expect(formatIcsUtc(new Date("2026-01-02T03:04:05Z"))).toBe("20260102T030405Z");
  });
});

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, comma, and newline", () => {
    expect(escapeIcsText("a,b;c\\d")).toBe("a\\,b\\;c\\\\d");
    expect(escapeIcsText("line1\nline2")).toBe("line1\\nline2");
    expect(escapeIcsText("crlf\r\nhere")).toBe("crlf\\nhere");
  });

  it("escapes backslash first so other escapes are not double-escaped", () => {
    // A literal backslash followed by a comma -> "\\" + "\,"
    expect(escapeIcsText("\\,")).toBe("\\\\\\,");
  });
});

describe("buildIcsEvent", () => {
  const ics = buildIcsEvent({
    uid: "booking-42@holt",
    start,
    end,
    summary: "Design consultation",
    description: "Bring photos",
    location: "123 Main St",
    organizerName: "Studio",
    attendeeEmail: "jane@example.com",
    stamp,
  });

  it("uses CRLF line endings", () => {
    expect(ics.includes("\r\n")).toBe(true);
    // No bare LF that isn't part of a CRLF.
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it("wraps a single VEVENT in a VCALENDAR with VERSION and PRODID", () => {
    expect(ics).toContain("BEGIN:VCALENDAR\r\n");
    expect(ics).toContain("VERSION:2.0\r\n");
    expect(ics).toContain("PRODID:-//Holt//Booking//EN\r\n");
    expect(ics).toContain("BEGIN:VEVENT\r\n");
    expect(ics).toContain("END:VEVENT\r\n");
    expect(ics.trimEnd().endsWith("END:VCALENDAR")).toBe(true);
  });

  it("emits UID, DTSTAMP, DTSTART, DTEND, SUMMARY", () => {
    expect(ics).toContain("UID:booking-42@holt\r\n");
    expect(ics).toContain("DTSTAMP:20260701T090000Z\r\n");
    expect(ics).toContain("DTSTART:20260715T143000Z\r\n");
    expect(ics).toContain("DTEND:20260715T150000Z\r\n");
    expect(ics).toContain("SUMMARY:Design consultation\r\n");
  });

  it("includes optional DESCRIPTION, LOCATION, ORGANIZER, ATTENDEE", () => {
    expect(ics).toContain("DESCRIPTION:Bring photos\r\n");
    expect(ics).toContain("LOCATION:123 Main St\r\n");
    expect(ics).toContain("ORGANIZER;CN=Studio:\r\n");
    expect(ics).toContain("ATTENDEE:mailto:jane@example.com\r\n");
  });

  it("ends the calendar object with a trailing CRLF", () => {
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("omits optional fields when not provided", () => {
    const minimal = buildIcsEvent({ uid: "u1", start, end, summary: "S", stamp });
    expect(minimal).not.toContain("DESCRIPTION:");
    expect(minimal).not.toContain("LOCATION:");
    expect(minimal).not.toContain("ORGANIZER");
    expect(minimal).not.toContain("ATTENDEE");
  });

  it("escapes special characters in the summary/description values", () => {
    const escaped = buildIcsEvent({
      uid: "u2",
      start,
      end,
      summary: "Sofa, chair; & more",
      description: "Note:\nsecond line",
      stamp,
    });
    expect(escaped).toContain("SUMMARY:Sofa\\, chair\\; & more\r\n");
    expect(escaped).toContain("DESCRIPTION:Note:\\nsecond line\r\n");
  });

  it("folds content lines longer than 75 octets with a leading space", () => {
    const longSummary = "X".repeat(200);
    const folded = buildIcsEvent({ uid: "u3", start, end, summary: longSummary, stamp });
    const lines = folded.split("\r\n");
    // Every physical line must be <= 75 octets (RFC 5545 3.1).
    for (const line of lines) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    // Continuation lines begin with a single space.
    const continuation = lines.find((l) => l.startsWith(" "));
    expect(continuation).toBeDefined();
    // Unfolding (strip CRLF + leading space) reconstructs the original summary.
    const unfolded = folded.replace(/\r\n /g, "");
    expect(unfolded).toContain(`SUMMARY:${longSummary}`);
  });
});

describe("buildIcsCalendar", () => {
  it("emits one VEVENT per event inside a single VCALENDAR", () => {
    const cal = buildIcsCalendar([
      { uid: "a", start, end, summary: "First", stamp },
      { uid: "b", start, end, summary: "Second", stamp },
    ]);
    expect((cal.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect((cal.match(/BEGIN:VCALENDAR/g) ?? []).length).toBe(1);
    expect(cal).toContain("UID:a\r\n");
    expect(cal).toContain("UID:b\r\n");
  });

  it("produces a valid empty calendar for no events", () => {
    const cal = buildIcsCalendar([]);
    expect(cal).toContain("BEGIN:VCALENDAR\r\n");
    expect(cal).toContain("END:VCALENDAR\r\n");
    expect(cal).not.toContain("BEGIN:VEVENT");
  });
});
