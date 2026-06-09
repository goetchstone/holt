// app/scripts/create-admin.mjs
//
// Bootstrap a local-login admin account for a self-hosted deployment that uses
// the email+password (credentials) sign-in method. This solves the chicken-
// and-egg problem: you can't sign in to set the first password, so this script
// creates (or updates) a SUPER_ADMIN StaffMember + linked User row directly.
//
// Usage (from app/):
//   node scripts/create-admin.mjs <email> <password> ["Display Name"]
//   AUTH_LOCAL_ENABLED=true must be set for the account to be usable at login.
//
// Idempotent: re-running with the same email resets that account's password.
//
// The scrypt format below MUST match lib/auth/password.ts. The test
// __tests__/password.test.ts pins the format so the two cannot drift.

import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const SCRYPT_N = 16384;
const SALT_BYTES = 16;
const KEY_BYTES = 64;

function hashPassword(plain) {
  if (!plain || plain.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(plain, salt, KEY_BYTES, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${key.toString("base64")}`;
}

async function main() {
  const [, , emailArg, passwordArg, nameArg] = process.argv;
  const email = (emailArg || "").trim().toLowerCase();
  const password = passwordArg || "";
  const displayName = nameArg || email.split("@")[0] || "Administrator";

  if (!email || !password) {
    console.error('Usage: node scripts/create-admin.mjs <email> <password> ["Display Name"]');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  // Prisma 7 uses the pg driver adapter (no Rust engine) — a bare
  // PrismaClient() throws without it. Mirror lib/prisma.ts.
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Export it (or load app/.env.local) before running.");
    process.exit(1);
  }
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const passwordHash = hashPassword(password);

    const user = await prisma.user.upsert({
      where: { email },
      update: { name: displayName },
      create: { email, name: displayName },
      select: { id: true },
    });

    const existingStaff = await prisma.staffMember.findFirst({ where: { email } });
    if (existingStaff) {
      await prisma.staffMember.update({
        where: { id: existingStaff.id },
        data: { passwordHash, userId: user.id, isActive: true, role: "SUPER_ADMIN" },
      });
      console.log(`Updated existing staff "${email}" as SUPER_ADMIN with a new password.`);
    } else {
      await prisma.staffMember.create({
        data: {
          email,
          displayName,
          role: "SUPER_ADMIN",
          isActive: true,
          userId: user.id,
          passwordHash,
        },
      });
      console.log(`Created SUPER_ADMIN staff "${email}".`);
    }

    console.log("Set AUTH_LOCAL_ENABLED=true in the environment to allow password sign-in.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
