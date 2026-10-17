// /app/src/lib/inventory/boxes.ts
//
// Boxes are evidence, never a quantity (ledger plan phase 16; the owner's
// design goal: item quantity is the only quantity). A sofa that ships in 3
// boxes is one unit; Product.boxesPerUnit (3) is the only box fact stored.
// Scans of its box labels (B-<product>-<box>-<of>) are assembled into whole
// units here, and whatever does not make a whole unit is an incomplete set:
// still one unit, owned, but kept in quarantine until its last box arrives,
// with a BoxNote saying which boxes it is missing.
//
// Pure.

export class BoxError extends Error {}

export const BOX_NOTE_KINDS = {
  INCOMPLETE: "A unit missing some of its boxes",
  STRAY: "A box sitting away from the rest of its unit",
} as const;

export type BoxNoteKind = keyof typeof BOX_NOTE_KINDS;

export interface IncompleteSet {
  present: number[];
  missing: number[];
}

export interface AssembledUnits {
  /** Whole units: every one of their boxes was scanned. */
  units: number;
  /** One per partial unit, most complete first. */
  incomplete: IncompleteSet[];
}

/** The box numbers a unit of `boxesPerUnit` boxes has: 1..n. */
export function boxNumbers(boxesPerUnit: number): number[] {
  const n = Math.max(1, Math.floor(boxesPerUnit));
  return Array.from({ length: n }, (_, i) => i + 1);
}

/**
 * Whole units and incomplete sets from the box numbers scanned. Boxes 1,1,2,3
 * of a 3-box sofa are one sofa and an incomplete one (box 1, missing 2 and 3).
 * A box number outside 1..boxesPerUnit is refused: the label belongs to a
 * different product setup than the one on file.
 */
export function assembleUnits(boxesPerUnit: number, boxes: number[]): AssembledUnits {
  const numbers = boxNumbers(boxesPerUnit);
  const count = new Map(numbers.map((b) => [b, 0]));
  for (const b of boxes) {
    if (!count.has(b)) {
      throw new BoxError(
        `Box ${b} does not exist on a unit of ${numbers.length} box${numbers.length === 1 ? "" : "es"}.`,
      );
    }
    count.set(b, count.get(b)! + 1);
  }
  const units = Math.min(...count.values());
  const left = new Map(numbers.map((b) => [b, count.get(b)! - units]));
  const sets = Math.max(...left.values());
  const incomplete: IncompleteSet[] = [];
  for (let k = 1; k <= sets; k++) {
    const present = numbers.filter((b) => left.get(b)! >= k);
    incomplete.push({ present, missing: numbers.filter((b) => !present.includes(b)) });
  }
  return { units, incomplete };
}

/** The boxes a set still misses once `arrived` are added to it. */
export function stillMissing(missing: number[], arrived: number[]): number[] {
  const left = [...missing];
  for (const b of arrived) {
    const i = left.indexOf(b);
    if (i === -1) throw new BoxError(`Box ${b} is not one this set is missing.`);
    left.splice(i, 1);
  }
  return left;
}
