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
//   SHA-256 of the raw token in PasswordResetToken, 1-hour expiry. (The
//   reset EMAIL, raw link included, is kept in EmailQueue.html by
//   lib/email/queue.ts; see docs/domains/staff-auth.md.) The member's row is
//   locked and re-read before the token is made, so a request that read the
//   row just before an admin changed its email or switched the member off
//   makes no token: those writes void open tokens (pages/api/staff/[id].ts)
//   and must not be outrun.
//
//   consumePasswordReset(rawToken, newPassword) — atomically validates
//   (exists, unexpired, unused, member still active), sets the new scrypt
//   hash, and marks the token used. A second use of the same link fails.

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
  return prisma.$transaction(async (tx) => {
    // Same lock order as the staff routes: the member's row, then its tokens.
    await tx.$queryRaw`SELECT id FROM "StaffMember" WHERE id = ${staff.id} FOR UPDATE`;
    const now = await tx.staffMember.findUnique({
      where: { id: staff.id },
      select: { email: true, isActive: true, displayName: true },
    });
    if (!now?.isActive || (now.email ?? "").trim().toLowerCase() !== normalized) return null;
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
    return { rawToken, email: now.email ?? staff.email ?? "", displayName: now.displayName };
  });
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
  const invalid = { ok: false as const, reason: "This reset link is invalid or has expired" };
  return prisma.$transaction(async (tx) => {
    const found = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { staffMemberId: true },
    });
    if (!found) return invalid;
    // Lock the member, then re-read the token: an email change or a
    // deactivation that voided it has committed by now, or waits for us.
    await tx.$queryRaw`SELECT id FROM "StaffMember" WHERE id = ${found.staffMemberId} FOR UPDATE`;
    const token = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        staffMemberId: true,
        expiresAt: true,
        usedAt: true,
        staffMember: { select: { isActive: true } },
      },
    });
    if (!token || token.usedAt !== null || token.expiresAt < new Date()) return invalid;
    // A member switched off since the link was sent gets no password.
    if (!token.staffMember.isActive) return invalid;
    const used = await tx.passwordResetToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) return invalid;
    await tx.staffMember.update({
      where: { id: token.staffMemberId },
      data: { passwordHash },
    });
    return { ok: true as const };
  });
}
