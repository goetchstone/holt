// /app/src/lib/booking/ics.ts
//
// Pure iCalendar (RFC 5545) builders. No I/O. Produces VCALENDAR/VEVENT text
// that any standard calendar (Google, Outlook, Apple) can import directly, so
// the booking flow needs no per-provider OAuth.
//
// Standards notes:
//   - Lines are CRLF-terminated (RFC 5545 section 3.1).
//   - DTSTART/DTEND/DTSTAMP are UTC in basic form "YYYYMMDDTHHMMSSZ".
//   - TEXT values escape backslash, semicolon, comma, and newline; backslash
//     is escaped first so the other escapes are not double-escaped (section 3.3.11).
//   - Long content lines are folded at 75 octets with a leading space on
//     continuation lines (section 3.1).

export interface IcsEventInput {
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  location?: string;
  organizerName?: string;
  attendeeEmail?: string;
  /** Stamp time; defaults to `new Date()`. Injectable so tests are deterministic. */
  stamp?: Date;
}

const PRODID = "-//Holt//Booking//EN";

// Two-digit zero pad for date/time components.
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// Date -> "YYYYMMDDTHHMMSSZ" in UTC (RFC 5545 UTC date-time form).
export function formatIcsUtc(date: Date): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

// Escape a TEXT value per RFC 5545 section 3.3.11. Backslash must be escaped
// first, then semicolon, comma, and newline (CR is dropped so a lone CRLF in
// input collapses to a single escaped "\n").
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Fold a single content line to <=75 octets per line. Continuation lines start
// with a single space. Folding operates on UTF-8 byte length, not code points.
function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const out: string[] = [];
  let current = "";
  let currentBytes = 0;
  let first = true;

  for (const char of line) {
    const charBytes = encoder.encode(char).length;
    // Continuation lines reserve one octet for the leading space.
    const limit = first ? 75 : 74;
    if (currentBytes + charBytes > limit) {
      out.push(first ? current : ` ${current}`);
      first = false;
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  out.push(first ? current : ` ${current}`);
  return out.join("\r\n");
}

function joinLines(lines: string[]): string {
  return lines.map(foldLine).join("\r\n");
}

// Build the VEVENT body lines (no VCALENDAR wrapper) so buildIcsCalendar can
// compose many events into one VCALENDAR.
function buildVevent(event: IcsEventInput): string[] {
  const lines: string[] = ["BEGIN:VEVENT"];
  lines.push(`UID:${escapeIcsText(event.uid)}`);
  lines.push(`DTSTAMP:${formatIcsUtc(event.stamp ?? new Date())}`);
  lines.push(`DTSTART:${formatIcsUtc(event.start)}`);
  lines.push(`DTEND:${formatIcsUtc(event.end)}`);
  lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
  if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcsText(event.location)}`);
  if (event.organizerName) lines.push(`ORGANIZER;CN=${escapeIcsText(event.organizerName)}:`);
  if (event.attendeeEmail) {
    lines.push(`ATTENDEE:mailto:${escapeIcsText(event.attendeeEmail)}`);
  }
  lines.push("END:VEVENT");
  return lines;
}

// A single-event VCALENDAR (the "Add to calendar" download).
export function buildIcsEvent(event: IcsEventInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...buildVevent(event),
    "END:VCALENDAR",
  ];
  // RFC 5545 requires the iCalendar object itself end with a CRLF.
  return `${joinLines(lines)}\r\n`;
}

// A multi-event VCALENDAR (the staff subscription feed).
export function buildIcsCalendar(events: IcsEventInput[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events.flatMap(buildVevent),
    "END:VCALENDAR",
  ];
  return `${joinLines(lines)}\r\n`;
}
