// /app/src/lib/auth/passwordReset.ts
//
// Forgot-password flow for local-account staff (credentials sign-in method).
// Two operations, both enumeration-safe and single-use:
//
//   requestPasswordReset(email) — silently returns null for unknown emails,
//   inactive staff, and OAuth-only accounts (no passwordHash and local auth
//   would still let them set one — we DO allow reset for any active staff
//   with the email, so an OAuth-only user can adopt a local password when
//   the deployment enables it). Voids prior open tokens, stores only the
//   SHA-256 of the raw token, 1-hour expiry.
//
//   consumePasswordReset(rawToken, newPassword) — atomically validates
//   (exists, unexpired, unused), sets the new scrypt hash, and marks the
//   token used. A second use of the same link fails.

import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth/password";

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

export function hashResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface ResetRequestResult {
  rawToken: string;
  email: string;
  displayName: string;
}

export async function requestPasswordReset(email: string): Promise<ResetRequestResult | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const staff = await prisma.staffMember.findFirst({
    where: { email: { equals: normalized, mode: "insensitive" }, isActive: true },
    select: { id: true, email: true, displayName: true },
  });
  if (!staff?.email) return null;

  const rawToken = randomBytes(32).toString("base64url");
  await prisma.$transaction(async (tx) => {
    await tx.passwordResetToken.updateMany({
      where: { staffMemberId: staff.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    await tx.passwordResetToken.create({
      data: {
        staffMemberId: staff.id,
        tokenHash: hashResetToken(rawToken),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      },
    });
  });
  return { rawToken, email: staff.email, displayName: staff.displayName };
}

export async function consumePasswordReset(
  rawToken: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // hashPassword enforces the length floor and throws a user-readable message.
  let passwordHash: string;
  try {
    passwordHash = hashPassword(newPassword);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "Invalid password" };
  }

  const tokenHash = hashResetToken(rawToken ?? "");
  return prisma.$transaction(async (tx) => {
    const token = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, staffMemberId: true, expiresAt: true, usedAt: true },
    });
    if (!token || token.usedAt !== null || token.expiresAt < new Date()) {
      return { ok: false as const, reason: "This reset link is invalid or has expired" };
    }
    await tx.staffMember.update({
      where: { id: token.staffMemberId },
      data: { passwordHash },
    });
    await tx.passwordResetToken.update({
      where: { id: token.id },
      data: { usedAt: new Date() },
    });
    return { ok: true as const };
  });
}
