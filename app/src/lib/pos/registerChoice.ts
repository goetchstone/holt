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
