// /app/src/server/trpc/routers/account.ts
//
// Self-service account surface: who am I + change my password. Any signed-in
// user (protectedProcedure) — these act only on the caller's own staff
// record, resolved from the session userId, never from input.

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { prisma } from "@/lib/prisma";
import { router, protectedProcedure } from "../trpc";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

async function staffForUser(userId: string) {
  return prisma.staffMember.findFirst({
    where: { userId },
    select: {
      id: true,
      displayName: true,
      email: true,
      role: true,
      passwordHash: true,
    },
  });
}

export const accountRouter = router({
  me: protectedProcedure.query(async ({ ctx }) => {
    const staff = await staffForUser(ctx.userId);
    if (!staff) {
      throw new TRPCError({ code: "NOT_FOUND", message: "No staff record for this account." });
    }
    return {
      displayName: staff.displayName,
      email: staff.email,
      role: String(staff.role),
      hasLocalPassword: staff.passwordHash !== null,
      localAuthEnabled: Boolean(process.env.AUTH_LOCAL_ENABLED),
    };
  }),

  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().max(200),
        newPassword: z.string().min(8).max(200),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!process.env.AUTH_LOCAL_ENABLED) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Local passwords are not enabled on this deployment.",
        });
      }
      const staff = await staffForUser(ctx.userId);
      if (!staff) {
        throw new TRPCError({ code: "NOT_FOUND", message: "No staff record for this account." });
      }
      // An existing password must be proven before it can be replaced. An
      // OAuth-only account (no hash yet) may set its first password directly.
      if (staff.passwordHash !== null) {
        if (!verifyPassword(input.currentPassword, staff.passwordHash)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Current password is incorrect." });
        }
      }
      await prisma.staffMember.update({
        where: { id: staff.id },
        data: { passwordHash: hashPassword(input.newPassword) },
      });
      return { ok: true };
    }),
});
