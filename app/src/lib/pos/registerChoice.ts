// /app/src/lib/pos/registerChoice.ts
//
// The register this browser works at. The register screen asks once and
// remembers the answer here; other screens that book money against a till (a
// refund from the order page) read it, so the money lands in the till of the
// register the person is standing at. One key, one home: the register screen
// had it as a private constant.

export const REGISTER_STORAGE_KEY = "pos-register-id";

/** The remembered register's id, or null when none was chosen (or storage is unavailable). */
export function rememberedRegisterId(): number | null {
  try {
    const saved = globalThis.localStorage?.getItem(REGISTER_STORAGE_KEY);
    if (!saved) return null;
    const id = Number.parseInt(saved, 10);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    // Private mode or blocked storage: no register is remembered.
    return null;
  }
}

/**
 * What a register has, said beside its name where one is chosen: whether a till
 * is open there (always said, since cash turns on it) and its card reader when
 * it has one. From the register list's flags (GET /api/registers).
 */
export function registerHas(register: { hasOpenTill?: boolean; hasCardReader?: boolean }): string {
  const till = register.hasOpenTill ? "Till open" : "No till open";
  return register.hasCardReader ? `${till} · Card reader` : till;
}

/**
 * Cash goes into a till's drawer and comes back out of one. True when money
 * moving this way has no open till to be counted in: the register's payment
 * screen and the order page's Refund then say so instead of moving it. Until
 * 2026-11-28 the register took cash with no till open, and it was in no till's
 * count. The routes themselves still accept it (a return's refund, an API
 * caller); whether they should is the owner's open question (pos.md).
 */
export function cashNeedsTill(method: string | null, tillId: number | null | undefined): boolean {
  return method === "CASH" && tillId == null;
}
