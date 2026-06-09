// /app/src/lib/money.ts
//
// Centralized money/decimal utilities. Every Prisma Decimal field in the
// codebase should pass through these helpers before use in calculations
// or JSON responses. Eliminates the ad-hoc Number() / toNum() / round2()
// pattern that caused the customer summary concatenation bug.

import { Prisma } from "@prisma/client";

type Decimal = Prisma.Decimal;
type DecimalLike = Decimal | number | string | null | undefined;

// Converts any Prisma Decimal (or null/undefined) to a plain number.
// Safe to call on values that are already numbers.
export function toNumber(value: DecimalLike): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

// Rounds a number to 2 decimal places using banker-safe rounding.
// Use for all money calculations to prevent floating-point drift.
export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

// Formats a number as USD currency string for display.
// Guards against null/undefined/NaN to prevent bare "$" rendering.
export function formatUSD(value: DecimalLike): string {
  const num = toNumber(value);
  return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

// Converts a Decimal field to a rounded number in one step.
// Typical usage in API responses: `netPrice: toMoney(item.netPrice)`
export function toMoney(value: DecimalLike): number {
  return roundMoney(toNumber(value));
}
