// /app/src/lib/staffAttribution.ts
//
// Classifies the salesperson strings on imported orders that never resolved to
// a StaffMember, so each one can be given the right kind of record.
//
// Why they exist at all: reporting was designer-only for years, so people who
// sold from Apparel or the Home Shop were never entered as staff -- but their
// names still landed on every order they wrote. Alongside them are POS terminal
// logins, which are not people and must never become staff records.
//
// The reference dataset holds 34 such names across 13,931 orders. Amy Sage
// DeMik is the shape they should all have: archived StaffMember, every one of
// her 689 orders FK-linked. Allison is the shape they do have: no record at
// all, 904 orders and $2.4M unattributed.
//
// Pure and tested; the database work lives in scripts/resolve-salespeople.impl.ts.

/** A name that appears on orders with no StaffMember behind it. */
export interface UnresolvedSalesperson {
  name: string;
  orderCount: number;
  lastOrderDate: Date;
}

export type AttributionKind =
  /** A POS terminal or system login. Never a person; never gets a staff record. */
  | "terminal"
  /** Someone still selling. Needs an ACTIVE record -- this is a live gap. */
  | "active-person"
  /** Someone who has left. Needs an ARCHIVED record so history stays attributed. */
  | "departed-person";

export interface Classification {
  name: string;
  kind: AttributionKind;
  /** Why, in words, so a reviewer can disagree with a specific claim. */
  rationale: string;
}

/**
 * Terminal logins follow a station-naming convention -- `OSRegister1`,
 * `Chregister2`, `GBRegister1` -- plus bare system accounts.
 *
 * Matched on a whole-word-ish basis rather than a substring: a real person
 * surnamed "Register" is unlikely, but "Administrator" as a display name is
 * not, and quietly turning a person into a terminal would erase their sales.
 */
const TERMINAL_PATTERNS = [/register\s*\d*$/i, /^admin(istrator)?$/i, /^system$/i, /^pos\d*$/i];

export function isTerminalName(name: string): boolean {
  const trimmed = name.trim();
  return TERMINAL_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Days since a name's last order after which its owner is treated as departed.
 *
 * 180 rather than 90: furniture sales cycles are long and staff take leave, so
 * a shorter window would archive people who are merely between sales. Archiving
 * someone who still works there is the worse error -- it hides them from
 * pickers and reports while their orders keep arriving.
 */
export const DEPARTED_AFTER_DAYS = 180;

export function classifySalesperson(entry: UnresolvedSalesperson, today: Date): Classification {
  if (isTerminalName(entry.name)) {
    return {
      name: entry.name,
      kind: "terminal",
      rationale: `matches a POS station naming convention (${entry.orderCount} orders)`,
    };
  }
  const days = Math.floor((today.getTime() - entry.lastOrderDate.getTime()) / 86_400_000);
  if (days > DEPARTED_AFTER_DAYS) {
    return {
      name: entry.name,
      kind: "departed-person",
      rationale: `last sold ${days} days ago, past the ${DEPARTED_AFTER_DAYS}-day window`,
    };
  }
  return {
    name: entry.name,
    kind: "active-person",
    rationale: `sold ${days} days ago — still selling, and currently unattributed`,
  };
}

/** The StaffMember fields a classification implies. Terminals return null. */
export function staffRecordFor(
  c: Classification,
): { role: "REGISTER"; isDesigner: false; isActive: boolean } | null {
  if (c.kind === "terminal") return null;
  // REGISTER with isDesigner false on purpose. These are Apparel and Home Shop
  // sellers; giving them DESIGNER would drop them into designer commission
  // reports they were never part of, which is the opposite of the fix.
  return { role: "REGISTER", isDesigner: false, isActive: c.kind === "active-person" };
}
