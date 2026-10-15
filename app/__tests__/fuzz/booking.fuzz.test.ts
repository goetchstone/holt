// /app/__tests__/fuzz/booking.fuzz.test.ts
//
// Property-based fuzzing of the public booking flow, end to end through the
// pure layers: the unauthenticated POST body (lib/booking/requestBody.ts), the
// booking -> calendar mapping (lib/booking/event.ts), the .ics a stranger can
// download (lib/booking/ics.ts), and the confirmation email
// (lib/email/templates.ts). Every free-text field here is typed by whoever
// fills in the public form.
//
// Found two real bugs:
//  - escapeIcsText passed control characters through, so a NUL or vertical
//    tab in the notes produced an .ics that violates RFC 5545 (TEXT forbids
//    CTL other than HTAB) and that strict calendar importers reject.
//    Counterexample: customerName = "\u0000".
//  - bookingInputSchema's end-after-start refine still ran when a date was
//    empty (an empty string fails .min(1) and never reaches the Date
//    transform), called .getTime() on the string, and threw a TypeError that
//    the handler returned to the visitor as a 400:
//    "data.startsAt.getTime is not a function". Counterexample (shrunk):
//    { customerName: "", customerEmail: "a@a.aa", startsAt: "", endsAt: "", ... }.
//    The admin time-off parser (lib/booking/serviceRequestBody.ts) had the
//    same refine and is covered below.

import fc from "fast-check";
import { parseBookingInput } from "@/lib/booking/requestBody";
import { parseBlockCreateInput } from "@/lib/booking/serviceRequestBody";
import { bookingToIcsEvent } from "@/lib/booking/event";
import { buildIcsEvent } from "@/lib/booking/ics";
import { bookingConfirmationEmail } from "@/lib/email/templates";
import {
  anyString,
  jsonObjectWithProtoKeys,
  nastyString,
  withoutPrototypePollution,
} from "./support";

// Free text as a stranger types it: any code point, plus the dictionary.
const freeText = fc.oneof(anyString(120), nastyString());
const isoString = fc
  .date({
    min: new Date("1970-01-01T00:00:00Z"),
    max: new Date("2100-01-01T00:00:00Z"),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString());

// Mostly-valid, sometimes-hostile: each field is well-formed three times in
// four, so a good share of bodies reach the success path (where the
// end-after-start and trimmed-name guarantees live) instead of all dying at
// the first rejection.
const mostly = <T, U>(valid: fc.Arbitrary<T>, hostile: fc.Arbitrary<U>) =>
  fc.oneof({ arbitrary: valid, weight: 3 }, { arbitrary: hostile, weight: 1 });
const nearValidBody = fc.record({
  customerName: mostly(fc.stringMatching(/^ ?[A-Za-z][A-Za-z '-]{0,30}$/), freeText),
  // fc.emailAddress() is RFC-valid but mostly outside what z.email() accepts,
  // so the "valid" side is a plain address the schema takes.
  customerEmail: mostly(
    fc.stringMatching(/^[a-z0-9]{1,10}(\.[a-z0-9]{1,5})?@[a-z0-9]{1,10}\.[a-z]{2,6}$/),
    fc.oneof(fc.emailAddress(), freeText),
  ),
  customerPhone: fc.option(freeText, { nil: null }),
  serviceType: fc.option(freeText, { nil: null }),
  serviceId: mostly(
    fc.option(fc.integer({ min: 1, max: 1000 }), { nil: null }),
    fc.oneof(fc.integer(), freeText),
  ),
  startsAt: mostly(isoString, freeText),
  endsAt: mostly(isoString, freeText),
  notes: fc.option(freeText, { nil: null }),
});

const anyBody = fc.oneof(
  { arbitrary: nearValidBody, weight: 3 },
  { arbitrary: jsonObjectWithProtoKeys(), weight: 1 },
  { arbitrary: fc.anything(), weight: 1 },
);

describe("parseBookingInput (lib/booking/requestBody.ts)", () => {
  it("returns a well-formed booking or throws an Error with a message -- nothing else", () => {
    fc.assert(
      fc.property(anyBody, (body) => {
        withoutPrototypePollution(() => {
          let parsed;
          try {
            parsed = parseBookingInput(body);
          } catch (e) {
            // The handler returns this message to the visitor as a 400, so it
            // must be the function's own Error -- a TypeError escaping from
            // inside the schema would put "x.getTime is not a function" on
            // the public form.
            expect(e).toBeInstanceOf(Error);
            expect((e as Error).name).toBe("Error");
            expect((e as Error).message.length).toBeGreaterThan(0);
            return;
          }
          expect(parsed.customerName).toBe(parsed.customerName.trim());
          expect(parsed.customerName.length).toBeGreaterThan(0);
          expect(Number.isNaN(parsed.startsAt.getTime())).toBe(false);
          expect(parsed.endsAt.getTime()).toBeGreaterThan(parsed.startsAt.getTime());
        });
      }),
    );
  });
});

describe("parseBlockCreateInput (lib/booking/serviceRequestBody.ts)", () => {
  it("returns a well-formed time-off block or throws its own Error -- nothing else", () => {
    const blockBody = fc.record({
      startsAt: mostly(isoString, fc.oneof(freeText, fc.constant(""))),
      endsAt: mostly(isoString, fc.oneof(freeText, fc.constant(""))),
      reason: fc.option(freeText, { nil: null }),
      staffMemberId: mostly(fc.option(fc.integer({ min: 1, max: 99 }), { nil: null }), freeText),
    });
    fc.assert(
      fc.property(fc.oneof({ arbitrary: blockBody, weight: 3 }, fc.anything()), (body) => {
        let parsed;
        try {
          parsed = parseBlockCreateInput(body);
        } catch (e) {
          expect((e as Error).name).toBe("Error");
          return;
        }
        expect(parsed.endsAt.getTime()).toBeGreaterThan(parsed.startsAt.getTime());
      }),
    );
  });
});

// ── The .ics a customer downloads ────────────────────────────────────────────

// Reverse RFC 5545 section 3.3.11 TEXT escaping, written independently of
// lib/booking/ics.ts so the two can disagree.
function unescapeIcsText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

// What a TEXT value can faithfully carry: line breaks normalise to LF, and
// control characters other than tab/newline cannot be represented at all.
function representableText(value: string): string {
  return value.replace(/\r\n|\r/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

const EXPECTED_PROPERTIES = [
  "BEGIN",
  "VERSION",
  "PRODID",
  "CALSCALE",
  "METHOD",
  "BEGIN",
  "UID",
  "DTSTAMP",
  "DTSTART",
  "DTEND",
  "SUMMARY",
  "DESCRIPTION",
  "LOCATION",
  "ORGANIZER",
  "ATTENDEE",
  "END",
  "END",
];

const booking = fc.record({
  id: fc.integer({ min: 1, max: 2 ** 31 - 1 }),
  customerName: freeText.filter((s) => s.trim().length > 0),
  customerEmail: fc.emailAddress(),
  serviceType: fc.option(
    freeText.filter((s) => s.length > 0),
    { nil: null },
  ),
  notes: fc.option(
    freeText.filter((s) => s.length > 0),
    { nil: null },
  ),
  startsAt: fc.date({
    min: new Date("2000-01-01"),
    max: new Date("2099-12-31"),
    noInvalidDate: true,
  }),
  durationMinutes: fc.integer({ min: 1, max: 600 }),
});
// The organizer and location come from the deployment's settings, not the
// public form.
const settingsText = fc.stringMatching(/^[A-Za-z0-9 &'.-]{1,60}$/);

describe("buildIcsEvent for a public booking (lib/booking/ics.ts)", () => {
  it("emits only the expected properties, folded to 75 octets, carrying the text intact", () => {
    fc.assert(
      fc.property(booking, settingsText, settingsText, (b, organizerName, location) => {
        const event = bookingToIcsEvent(
          { ...b, endsAt: new Date(b.startsAt.getTime() + b.durationMinutes * 60_000) },
          { organizerName, location },
        );
        const ics = buildIcsEvent({ ...event, stamp: new Date("2026-01-01T00:00:00Z") });

        // Physical lines: CRLF only, never a bare CR or LF, at most 75 octets.
        expect(ics.endsWith("\r\n")).toBe(true);
        const physical = ics.slice(0, -2).split("\r\n");
        for (const line of physical) {
          expect(line).not.toMatch(/[\r\n]/);
          expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
          // RFC 5545 forbids control characters other than HTAB in content.
          expect(line).not.toMatch(/[\u0000-\u0008\u000a-\u001f\u007f]/);
        }

        // Logical lines: user text can never start a property or component.
        const logical = ics.slice(0, -2).replace(/\r\n /g, "").split("\r\n");
        expect(logical.map((l) => /^[A-Z-]+/.exec(l)?.[0])).toEqual(EXPECTED_PROPERTIES);

        const value = (name: string): string => {
          const line = logical.find((l) => l.startsWith(`${name}:`));
          return line === undefined ? "" : line.slice(name.length + 1);
        };
        expect(unescapeIcsText(value("SUMMARY"))).toBe(representableText(event.summary));
        expect(unescapeIcsText(value("DESCRIPTION"))).toBe(
          representableText(event.description ?? ""),
        );
        expect(value("DTSTART")).toMatch(/^\d{8}T\d{6}Z$/);
      }),
    );
  });
});

describe("bookingConfirmationEmail (lib/email/templates.ts)", () => {
  it("customer text never adds markup to the email", () => {
    const tags = (html: string): string[] => html.match(/<\/?[a-zA-Z][^>]*>/g) ?? [];
    const base = bookingConfirmationEmail({
      appName: "Holt",
      customerName: "Pat",
      serviceName: "Design consult",
      startsAt: new Date("2026-05-01T15:00:00Z"),
      timezone: "America/New_York",
    });
    fc.assert(
      fc.property(freeText, freeText, (customerName, serviceName) => {
        const email = bookingConfirmationEmail({
          appName: "Holt",
          customerName,
          serviceName: serviceName || "x",
          startsAt: new Date("2026-05-01T15:00:00Z"),
          timezone: "America/New_York",
        });
        expect(tags(email.html)).toEqual(tags(base.html));
      }),
    );
  });
});
