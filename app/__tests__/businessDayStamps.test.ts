// /app/__tests__/businessDayStamps.test.ts
//
// QUA-14: a generated number's YYMMDD is the BUSINESS day, from
// lib/reports/businessDay.ts businessDayStamp(instant, timeZone). Fourteen
// generators built it from the server's clock instead (`now.getFullYear()`,
// `getDate()`), so on a UTC server anything created in a US evening -- a
// return, a PO, a proposal, a ticket, an invoice -- was stamped with
// tomorrow's date.
//
// A ratchet: the server-clock two-digit-year shape may appear only in the
// files below, each with the reason it is not "today".

import { execFileSync } from "node:child_process";
import { join } from "node:path";

const APP = join(__dirname, "..");
// `now.getFullYear().toString().slice(-2)` and `String(d.getFullYear()).slice(2)`.
const SERVER_CLOCK_YY = String.raw`getFullYear\(\)(\.toString\(\))?\)?\.slice\(-?2\)`;

const CALENDAR_DATE_SITES: Record<string, string> = {
  "src/lib/deliveryService.ts":
    "findOrCreatePlanningRun numbers a run by its SCHEDULED date, and its whole day window is built the same way (setHours); moving only the stamp would disagree with the window.",
  "src/pages/api/dispatch/runs/index.ts":
    "POST numbers a run by the runDate the dispatcher picked, a calendar date, not today.",
};

function filesWithServerClockYY(): string[] {
  try {
    const out = execFileSync("grep", ["-rlE", SERVER_CLOCK_YY, "src"], {
      cwd: APP,
      encoding: "utf8",
    });
    return out.trim().split("\n").filter(Boolean).sort();
  } catch (err) {
    // grep exits 1 when nothing matches; anything else is an error, not a pass.
    if ((err as { status?: number }).status === 1) return [];
    throw err;
  }
}

describe("generated numbers date by the business day", () => {
  it("builds a two-digit year from the server clock only in the listed calendar-date sites", () => {
    expect(filesWithServerClockYY()).toEqual(Object.keys(CALENDAR_DATE_SITES).sort());
  });
});
