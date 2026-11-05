// /app/src/lib/pipelineFollowUp.ts
//
// When a quote next needs attention. A next follow-up date the designer set wins
// over the default clock: until that date the quote is on plan however long ago
// the last contact was ("call me after the holidays"), and from that date on it
// needs attention until someone reaches the client, by a logged contact or an
// outbound call. With no date, a quote goes overdue 7 days after the last contact
// (or after it was created, if nobody has reached out yet). Dates are YYYY-MM-DD
// calendar dates, so comparing the strings compares the dates.

export const OVERDUE_AFTER_DAYS = 7;

export type FollowUpState = "current" | "overdue" | "scheduled" | "due";

export function getFollowUpState(input: {
  nextFollowUpDate: string | null;
  lastContactDate: string | null;
  daysSinceContact: number | null;
  daysSinceCreated: number;
  today: string;
}): FollowUpState {
  const { nextFollowUpDate, lastContactDate } = input;
  if (nextFollowUpDate) {
    if (nextFollowUpDate > input.today) return "scheduled";
    const contactedSinceDate = lastContactDate !== null && lastContactDate >= nextFollowUpDate;
    if (!contactedSinceDate) return "due";
  }
  const daysWaiting = input.daysSinceContact ?? input.daysSinceCreated;
  return daysWaiting > OVERDUE_AFTER_DAYS ? "overdue" : "current";
}

export function needsAttention(state: FollowUpState): boolean {
  return state === "overdue" || state === "due";
}

export const NEXT_FOLLOW_UP_CHOICES = [
  { label: "1 week", days: 7 },
  { label: "2 weeks", days: 14 },
  { label: "1 month", days: 30 },
] as const;

export function addDaysToCalendarDate(date: string, days: number): string {
  const moved = new Date(`${date}T00:00:00.000Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** What a date should start as when logging a contact: a future plan still stands,
 *  but a date that has arrived is what this contact just took care of. */
export function nextFollowUpAfterContact(current: string | null, today: string): string | null {
  return current && current > today ? current : null;
}
