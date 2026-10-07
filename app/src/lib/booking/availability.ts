// /app/src/lib/booking/availability.ts
//
// Pure slot generation from a Service catalog: weekly AvailabilityWindows
// stepped by the service duration (+buffer), across a day window, minus busy
// intervals (existing bookings + calendar blocks) and the past. Mirrors
// lib/booking/slots.ts's Slot[] contract so the two engines are interchangeable
// in the availability endpoint -- the flat-hours generateSlots is the fallback
// when no windows are configured.

import type { Slot, BusyInterval } from "./slots";
import { hhmmToMinutes, isValidHHMM } from "./scheduling";

export interface ScheduleWindow {
  dayOfWeek: number; // 0=Sun..6=Sat
  startTime: string; // "HH:MM"
  endTime: string; // "HH:MM"
}

export interface ComputeWindowSlotsInput {
  /** Reference "now"; past slots are dropped. */
  fromDate: Date;
  /** Calendar days to generate from fromDate's day. */
  windowDays: number;
  /** Appointment length in minutes. */
  durationMinutes: number;
  /** Gap after each appointment; added to the step between candidate starts. */
  bufferMinutes: number;
  /** Weekly recurring windows (already scoped to the relevant service/org). */
  windows: ScheduleWindow[];
  /** Existing bookings + calendar blocks; any overlapping slot is excluded. */
  busy: BusyInterval[];
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function computeWindowSlots(input: ComputeWindowSlotsInput): Slot[] {
  const { fromDate, windowDays, durationMinutes, bufferMinutes, windows, busy } = input;
  if (durationMinutes <= 0 || windowDays <= 0 || windows.length === 0) return [];

  const step = durationMinutes + Math.max(0, bufferMinutes);
  const now = fromDate.getTime();
  const busyRanges = busy.map((b) => ({ start: b.startsAt.getTime(), end: b.endsAt.getTime() }));
  const seen = new Set<number>();
  const slots: Slot[] = [];

  const dayStart = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());

  for (let day = 0; day < windowDays; day++) {
    const date = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + day);
    const dow = date.getDay();

    for (const w of windows) {
      if (w.dayOfWeek !== dow) continue;
      if (!isValidHHMM(w.startTime) || !isValidHHMM(w.endTime)) continue;
      const ws = hhmmToMinutes(w.startTime);
      const we = hhmmToMinutes(w.endTime);
      if (we <= ws) continue;

      for (let minute = ws; minute + durationMinutes <= we; minute += step) {
        const startsAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minute);
        const start = startsAt.getTime();
        if (start <= now) continue;
        if (seen.has(start)) continue;
        const end = start + durationMinutes * 60_000;
        if (busyRanges.some((r) => overlaps(start, end, r.start, r.end))) continue;
        seen.add(start);
        slots.push({ startsAt, endsAt: new Date(end) });
      }
    }
  }

  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return slots;
}
