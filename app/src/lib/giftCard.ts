// /app/src/lib/giftCard.ts

export interface BalanceChange {
  newBalance: number;
  newStatus: "ACTIVE" | "REDEEMED";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computeRedemption(currentBalance: number, amount: number): BalanceChange {
  if (amount <= 0) throw new Error("Redemption amount must be greater than zero");
  if (amount > currentBalance) {
    throw new Error(
      `Redemption amount $${amount.toFixed(2)} exceeds balance $${currentBalance.toFixed(2)}`,
    );
  }
  const newBalance = round2(currentBalance - amount);
  return { newBalance, newStatus: newBalance === 0 ? "REDEEMED" : "ACTIVE" };
}

export function computeReload(currentBalance: number, amount: number): BalanceChange {
  if (amount <= 0) throw new Error("Reload amount must be greater than zero");
  const newBalance = round2(currentBalance + amount);
  return { newBalance, newStatus: "ACTIVE" };
}

export function computeAdjustment(
  currentBalance: number,
  newBalance: number,
): { delta: number; newStatus: "ACTIVE" | "REDEEMED" } {
  if (newBalance < 0) throw new Error("Balance cannot be negative");
  const adjustedBalance = round2(newBalance);
  const delta = round2(Math.abs(adjustedBalance - currentBalance));
  return { delta, newStatus: adjustedBalance === 0 ? "REDEEMED" : "ACTIVE" };
}
