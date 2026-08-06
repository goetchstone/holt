// app/prisma/seed/demo/staff.ts
//
// StaffMembers across every real role the seed spec calls for
// (SUPER_ADMIN, ADMIN, MANAGER, DESIGNER, REGISTER, WAREHOUSE), each with
// a linked User row and a working local-login password hashed through the
// SAME scrypt helper production auth uses (lib/auth/password.ts) — never
// reimplemented here, so a hash this script writes verifies correctly
// against `verifyPassword()` the day someone signs in with it.
//
// All seeded staff share one fixed demo password (documented in
// docs/domains/seed-data.md): every account is synthetic, so there is no
// per-person secret to protect, and a single documented password is what
// makes "log in and look around" actually usable.

import type { PrismaClient, StaffRole } from "@prisma/client";
import { hashPassword } from "@/lib/auth/password";

/** Every seeded staff account's local-login password. Synthetic data only —
 * documented openly in docs/domains/seed-data.md. */
export const DEMO_STAFF_PASSWORD = "Showroom2026!";

export interface SeededStaffMember {
  id: number;
  userId: string;
  displayName: string;
  role: StaffRole;
  isDesigner: boolean;
  homeStoreId: number | null;
}

export interface StaffSetup {
  all: SeededStaffMember[];
  superAdmin: SeededStaffMember;
  admin: SeededStaffMember;
  managers: SeededStaffMember[];
  designers: SeededStaffMember[];
  registerStaff: SeededStaffMember[];
  warehouseStaff: SeededStaffMember[];
}

interface RosterEntry {
  displayName: string;
  emailLocal: string;
  role: StaffRole;
  isDesigner: boolean;
  homeStoreId: number | null;
}

async function upsertStaff(
  prisma: PrismaClient,
  entry: RosterEntry,
  passwordHash: string,
): Promise<SeededStaffMember> {
  const email = `${entry.emailLocal}@example.com`;

  const user = await prisma.user.upsert({
    where: { email },
    update: { name: entry.displayName },
    create: { email, name: entry.displayName },
  });

  // Link roleId the way the RBAC migration's backfill does: Role.key === the
  // StaffRole value. Without it every seeded developer lands on
  // requirePermission's StaffRole fallback and the FK that production staff all
  // carry is never exercised locally. Null when the built-in roles have not been
  // seeded yet (`npm run seed:roles`, which scripts/setup.sh runs first) — the
  // fallback covers that, which is exactly what it exists for.
  const roleRow = await prisma.role.findUnique({
    where: { key: entry.role },
    select: { id: true },
  });

  const staff = await prisma.staffMember.upsert({
    where: { email },
    update: {
      displayName: entry.displayName,
      role: entry.role,
      roleId: roleRow?.id ?? null,
      isDesigner: entry.isDesigner,
      activeStoreLocationId: entry.homeStoreId,
      userId: user.id,
      passwordHash,
      isActive: true,
    },
    create: {
      email,
      displayName: entry.displayName,
      role: entry.role,
      roleId: roleRow?.id ?? null,
      isDesigner: entry.isDesigner,
      activeStoreLocationId: entry.homeStoreId,
      userId: user.id,
      passwordHash,
      isActive: true,
    },
  });

  return {
    id: staff.id,
    userId: user.id,
    displayName: staff.displayName,
    role: staff.role,
    isDesigner: staff.isDesigner,
    homeStoreId: entry.homeStoreId,
  };
}

/**
 * StoreSetup shape is imported structurally (id + code) rather than the
 * concrete `locations.ts` type, so this module doesn't need to know about
 * stock locations / registers at all.
 */
interface StoreLike {
  id: number;
  code: string;
}

export async function seedStaff(
  prisma: PrismaClient,
  stores: readonly StoreLike[],
  warehouseStoreLocationId: number,
  designerCount: number,
): Promise<StaffSetup> {
  const passwordHash = hashPassword(DEMO_STAFF_PASSWORD);
  const storeA = stores[0]?.id ?? null;
  const storeB = stores[1]?.id ?? stores[0]?.id ?? null;

  const superAdminEntry: RosterEntry = {
    displayName: "Jordan Ashcombe",
    emailLocal: "owner",
    role: "SUPER_ADMIN",
    isDesigner: false,
    homeStoreId: storeA,
  };
  const adminEntry: RosterEntry = {
    displayName: "Priya Deshmukh",
    emailLocal: "admin",
    role: "ADMIN",
    isDesigner: false,
    homeStoreId: storeA,
  };
  const managerEntries: RosterEntry[] = stores.map((store, i) => ({
    displayName: i === 0 ? "Marcus Lindqvist" : "Elena Beaumont",
    emailLocal: `manager.${store.code.toLowerCase()}`,
    role: "MANAGER",
    isDesigner: false,
    homeStoreId: store.id,
  }));

  const designerPool = [
    "Deshawn Okonkwo",
    "Ingrid Sokolov",
    "Liam Fairweather",
    "Talia Rutherford",
    "Owen Whitfield",
    "Renata Vasquez",
    "Noah Castellano",
    "Sofia Marchetti",
    "Caleb Merriweather",
    "Beatrix Novak",
    "Gabriel Solano",
    "Wren Pellegrini",
  ];
  const designerEntries: RosterEntry[] = Array.from({ length: designerCount }, (_, i) => {
    const name = designerPool[i % designerPool.length];
    const suffix = i >= designerPool.length ? String(Math.floor(i / designerPool.length) + 1) : "";
    return {
      displayName: `${name}${suffix}`,
      emailLocal: `designer${i + 1}`,
      role: "DESIGNER" as StaffRole,
      isDesigner: true,
      homeStoreId: i % 2 === 0 ? storeA : storeB,
    };
  });

  const registerEntries: RosterEntry[] = ["Kai Ohara", "Selah Danforth", "Bram Ivory"].map(
    (name, i) => ({
      displayName: name,
      emailLocal: `register${i + 1}`,
      role: "REGISTER" as StaffRole,
      isDesigner: false,
      homeStoreId: i % 2 === 0 ? storeA : storeB,
    }),
  );

  const warehouseEntries: RosterEntry[] = ["Tobias Kowalski", "Petra Aldrich"].map((name, i) => ({
    displayName: name,
    emailLocal: `warehouse${i + 1}`,
    role: "WAREHOUSE" as StaffRole,
    isDesigner: false,
    homeStoreId: warehouseStoreLocationId,
  }));

  const superAdmin = await upsertStaff(prisma, superAdminEntry, passwordHash);
  const admin = await upsertStaff(prisma, adminEntry, passwordHash);
  const managers: SeededStaffMember[] = [];
  for (const e of managerEntries) managers.push(await upsertStaff(prisma, e, passwordHash));
  const designers: SeededStaffMember[] = [];
  for (const e of designerEntries) designers.push(await upsertStaff(prisma, e, passwordHash));
  const registerStaff: SeededStaffMember[] = [];
  for (const e of registerEntries) registerStaff.push(await upsertStaff(prisma, e, passwordHash));
  const warehouseStaff: SeededStaffMember[] = [];
  for (const e of warehouseEntries) warehouseStaff.push(await upsertStaff(prisma, e, passwordHash));

  return {
    all: [superAdmin, admin, ...managers, ...designers, ...registerStaff, ...warehouseStaff],
    superAdmin,
    admin,
    managers,
    designers,
    registerStaff,
    warehouseStaff,
  };
}
