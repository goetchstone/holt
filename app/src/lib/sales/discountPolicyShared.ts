// /app/src/lib/sales/discountPolicyShared.ts
//
// GAP-06: how big a discount is, and the register PIN's shape. Shared by the
// screens, which show what a sale needs, and the server (discountApproval.ts),
// which decides. Client-safe: no Prisma here.
//
// A discount is a line sold below its list price, whichever way it got there:
// a discount entered at the register, a price typed lower, or a delivery fee
// cut below its zone's. It is measured per line, so one deep cut can't hide in
// a large sale.

/** A line as the policy sees it. */
export interface DiscountLine {
  /** The unit price it is listed at; null when it has none (nothing to discount from). */
  listUnit: number | null;
  quantity: number;
  /** What the whole line sells for, after every discount. */
  netPrice: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** How far below its list price a line sells, as a percent of that list (0-100). */
export function lineDiscountPercent(line: DiscountLine): number {
  const list = (line.listUnit ?? 0) * Math.abs(line.quantity);
  if (!(list > 0)) return 0;
  const off = list - Math.abs(line.netPrice);
  if (off <= 0.005) return 0;
  return Math.min(100, round2((off / list) * 100));
}

/** The deepest discount on any line of a sale. */
export function largestDiscountPercent(lines: readonly DiscountLine[]): number {
  return lines.reduce((max, line) => Math.max(max, lineDiscountPercent(line)), 0);
}

/** The money a line was discounted by: its list total less what it sells for. */
export function lineSaving(line: DiscountLine): number {
  const list = (line.listUnit ?? 0) * Math.abs(line.quantity);
  return Math.max(0, round2(list - Math.abs(line.netPrice)));
}

/** A register PIN: four to eight digits. */
export const PIN_PATTERN = /^\d{4,8}$/;

/** Why a string can't be a register PIN, or null when it can. */
export function pinProblem(pin: unknown): string | null {
  if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) {
    return "A PIN is 4 to 8 digits.";
  }
  return null;
}

/** A manager's approval, sent with the request that needs it. */
export interface DiscountApproval {
  approverId: number;
  pin: string;
}

/** The answer when a request needs a manager: code, and what was asked for. */
export const APPROVAL_REQUIRED = "DISCOUNT_APPROVAL_REQUIRED";

export interface ApprovalRequiredBody {
  error: string;
  code: typeof APPROVAL_REQUIRED;
  /** The deepest discount asked for, percent. */
  percent: number;
  /** What staff may give on their own, percent. */
  limit: number;
}

export function isApprovalRequired(body: unknown): body is ApprovalRequiredBody {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { code?: unknown }).code === APPROVAL_REQUIRED
  );
}

/** Someone who can approve: an active manager with a PIN set. */
export interface DiscountApprover {
  id: number;
  displayName: string;
}
