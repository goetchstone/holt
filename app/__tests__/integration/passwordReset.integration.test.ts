// /app/__tests__/integration/passwordReset.integration.test.ts
//
// Real-DB proof of the forgot-password flow: enumeration safety, single-use
// consumption, expiry, supersession of prior tokens, and that the new scrypt
// hash actually verifies. Auth code — real SQL, no mocked Prisma.

import { prisma } from "@/lib/prisma";
import { resetTestDb } from "@/lib/testing/withTestDb";
import {
  requestPasswordReset,
  consumePasswordReset,
  hashResetToken,
} from "@/lib/auth/passwordReset";
import { verifyPassword } from "@/lib/auth/password";

async function makeStaff(email: string, isActive = true) {
  return prisma.staffMember.create({
    data: { displayName: "Reset Test", email, isActive },
  });
}

describe("password reset flow against a real DB", () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("returns null for unknown emails and inactive staff (no enumeration)", async () => {
    await makeStaff("inactive@test.holt", false);
    expect(await requestPasswordReset("nobody@test.holt")).toBeNull();
    expect(await requestPasswordReset("inactive@test.holt")).toBeNull();
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it("issues a token, consumes it once, and the new password verifies", async () => {
    const staff = await makeStaff("dana@test.holt");
    const result = await requestPasswordReset("DANA@test.holt"); // case-insensitive
    expect(result).not.toBeNull();

    // Only the hash is stored — the raw token never touches the DB.
    const row = await prisma.passwordResetToken.findUniqueOrThrow({
      where: { tokenHash: hashResetToken(result!.rawToken) },
    });
    expect(row.usedAt).toBeNull();

    const consumed = await consumePasswordReset(result!.rawToken, "new-password-1");
    expect(consumed).toEqual({ ok: true });

    const updated = await prisma.staffMember.findUniqueOrThrow({ where: { id: staff.id } });
    expect(verifyPassword("new-password-1", updated.passwordHash)).toBe(true);

    // Second use of the same link fails.
    const again = await consumePasswordReset(result!.rawToken, "another-password");
    expect(again.ok).toBe(false);
  });

  it("requesting a new token voids the previous open one", async () => {
    await makeStaff("super@test.holt");
    const first = await requestPasswordReset("super@test.holt");
    const second = await requestPasswordReset("super@test.holt");
    expect((await consumePasswordReset(first!.rawToken, "password-xyz1")).ok).toBe(false);
    expect((await consumePasswordReset(second!.rawToken, "password-xyz1")).ok).toBe(true);
  });

  it("rejects expired tokens", async () => {
    await makeStaff("late@test.holt");
    const result = await requestPasswordReset("late@test.holt");
    await prisma.passwordResetToken.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const consumed = await consumePasswordReset(result!.rawToken, "password-xyz1");
    expect(consumed.ok).toBe(false);
  });

  it("rejects too-short passwords without touching the token", async () => {
    await makeStaff("short@test.holt");
    const result = await requestPasswordReset("short@test.holt");
    const consumed = await consumePasswordReset(result!.rawToken, "short");
    expect(consumed.ok).toBe(false);
    // Token stays usable for a valid retry.
    expect((await consumePasswordReset(result!.rawToken, "long-enough-pw")).ok).toBe(true);
  });
});
